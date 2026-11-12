from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import hashlib
import hmac
import json
import logging
import math
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import RequestResponseEndpoint

from app.database import (
    agent_log_snapshot,
    agent_status_snapshot,
    dispatch_outbox,
    dispose,
    fail_outbox_event,
    get_llm_settings,
    get_llm_settings_with_token,
    get_run_control,
    load_state,
    outbox_snapshot,
    replay_outbox_event,
    save_state,
    set_llm_settings,
    set_run_control,
)
from app import copilot_agent
from app.copilot_agent import CopilotJudgementError
from app.accounts import router as accounts_router
from app.accounts import (
    LOCKOUT_SECONDS,
    MAX_FAILED_LOGINS,
    UserAccount,
    _now_ms,
    account_locations,
)
from app.database import sessions
from app.sim_feed import SimFeedError, fetch_snapshot, simulator_candidates, simulator_feed
from app import live_agent
from app.security import Principal, require_roles, verify_token
from app.hazard_intel import (
    ensure_alert_fields,
    hazard_type_for,
    log_decision,
    record_outlook,
    seed_hazard_demo,
    tier_from_severity,
)
from sqlalchemy import select


logger = logging.getLogger(__name__)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def trace() -> str:
    return str(uuid4())


def request_hash(body: BaseModel) -> str:
    values = body.model_dump(mode="json")
    if isinstance(body, ReportIn):
        # Preserve retry hashes for reports created before optional wizard fields were introduced.
        for key, default in {"incidentType": "flood", "needs": [], "latitude": None, "longitude": None, "accuracyM": None}.items():
            if values.get(key) == default:
                values.pop(key, None)
    if isinstance(body, CheckInIn):
        # Keep retry hashes stable for check-ins queued before location fields existed.
        for key in ("latitude", "longitude", "accuracyM", "locationSource"):
            if values.get(key) is None:
                values.pop(key, None)
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def initial() -> dict:
    return {
        "agents": {
            agent: {"status": "stopped", "mode": "rules", "lastRun": None}
            for agent in ("a1", "a2", "a3")
        },
        "forecasts": [],
        "reports": [],
        "checkins": [],
        "consents": [],
        "resources": [
            {"id": "boat-01", "kind": "boat", "name": "Rescue boat 1", "capacity": 6, "status": "available"},
            {"id": "boat-02", "kind": "boat", "name": "Rescue boat 2", "capacity": 6, "status": "available"},
            {"id": "team-01", "kind": "response-team", "name": "Response team 1", "capacity": 6, "status": "available"},
            {"id": "team-02", "kind": "response-team", "name": "Response team 2", "capacity": 6, "status": "available"},
            {"id": "team-03", "kind": "response-team", "name": "Response team 3", "capacity": 6, "status": "available"},
            {"id": "shelter-01", "kind": "shelter", "name": "Community Hall", "capacity": 120, "status": "available"},
        ],
        "reservations": [],
        "volunteers": [],
        "incidents": [],
        "reviews": [],
        "plans": [],
        "tasks": [],
        "deliveries": [],
        "events": [],
        "audit": [],
        "hazardSimInputs": {},
        "hazardAlerts": [],
        "hazardOutlook": {},
        "volunteerRequests": [],
    }


S = initial()
state_lock = asyncio.Lock()
persisted_state = copy.deepcopy(S)
SIMULATION_SCAN_INTERVAL_SECONDS = 10
SIMULATION_INPUT_EVENT = "hazard.simulation.input_set.v1"
SIMULATION_CITY_COORDINATES = {
    "bengaluru": (12.9716, 77.5946),
    "kochi": (9.9312, 76.2673),
    "thiruvananthapuram": (8.5241, 76.9366),
    "chennai": (13.0827, 80.2707),
    "mumbai": (19.076, 72.8777),
    "delhi": (28.6139, 77.209),
    "kolkata": (22.5726, 88.3639),
}
# The live Hazard Intelligence agent runs all the time by default (set ASHRAAY_AGENTS_AUTOSTART=0 to
# start it paused). Start/Stop on the Hazard Prediction screen only pauses/resumes this loop.
AGENTS_AUTOSTART = os.getenv("ASHRAAY_AGENTS_AUTOSTART", "1") != "0"
# Also read every hazard source from the ASHRAAY Hazard Simulator (ashraay-sim) each tick.
AGENT_READS_SIM_FEED = os.getenv("ASHRAAY_AGENT_SIM_FEED", "1") != "0"
# Max new alerts the agent raises per 10-second tick, so a burst doesn't stall the API.
AGENT_MAX_NEW_SCANS_PER_TICK = int(os.getenv("ASHRAAY_AGENT_MAX_SCANS_PER_TICK", "8"))
auto_run = {
    "running": AGENTS_AUTOSTART,
    "scans": 0,
    "startedAt": None,
    "stoppedAt": None,
    "lastEventAt": None,
    "lastError": None,
    "lastTickAt": None,
    "nextTickAt": None,
    "intervalSeconds": SIMULATION_SCAN_INTERVAL_SECONDS,
    "simulatorSources": 0,
    "simulatorNote": None,
    "citizenSignals": None,
    "updates": 0,
}
auto_run_seen_events: set[str] = set()
# Fingerprints of simulator sources already scanned, so an unchanged reading isn't re-raised.
agent_seen_sources: dict[str, str] = {}
agent_user_fingerprint: dict[str, object] = {"value": None, "signals": None}


def audit(action: str, detail: dict, trace_id: str | None = None) -> dict:
    entry = {
        "id": str(uuid4()),
        "time": now(),
        "action": action,
        "detail": detail,
        "traceId": trace_id or trace(),
    }
    S["audit"].append(entry)
    return entry


def record_event(event_type: str, data: dict, trace_id: str | None = None) -> dict:
    event_time = now()
    subject = next(
        (
            f"{key}/{data[key]}"
            for key in ("incidentId", "reportId", "planId", "taskId", "id")
            if key in data
        ),
        None,
    )
    event = {
        "id": str(uuid4()),
        "type": f"org.ashraay.{event_type}",
        "ashraayeventtype": event_type,
        "datacontenttype": "application/json",
        "specversion": "1.0",
        "source": "urn:ashraay:pilot-simulator",
        "time": event_time,
        "traceid": trace_id or trace(),
        "jurisdictionid": "IN-KL-EKM",
        "dataschema": f"urn:ashraay:schema:{event_type}",
        "status": "processed",
        "data": copy.deepcopy(data),
    }
    if subject:
        event["subject"] = subject
    S["events"].append(event)
    return event


async def persist(reset_outbox: bool = False) -> None:
    global persisted_state
    try:
        await save_state(copy.deepcopy(S), reset_outbox=reset_outbox)
    except SQLAlchemyError as exc:
        logger.exception("Simulator state transaction failed; restoring the last committed state.")
        S.clear()
        S.update(copy.deepcopy(persisted_state))
        raise HTTPException(
            status_code=503,
            detail="Simulator state could not be saved. Retry after the database recovers.",
        ) from exc
    S["events"] = S["events"][-500:]
    persisted_state = copy.deepcopy(S)


# Set ASHRAAY_RESET_ON_START=0 to keep simulator data (hazards, incidents, volunteer profiles, ...)
# across restarts instead of starting each run from a clean slate (the default for local testing).
RESET_ON_START = os.getenv("ASHRAAY_RESET_ON_START", "1") != "0"
# Set ASHRAAY_SEED_HAZARD_DEMO=0 to start without the synthetic Bengaluru hazard alerts.
SEED_HAZARD_DEMO = os.getenv("ASHRAAY_SEED_HAZARD_DEMO", "1") != "0"


@asynccontextmanager
async def lifespan(_: FastAPI):
    global persisted_state
    S.clear()
    loaded = await load_state()
    if RESET_ON_START:
        loaded = {}
    compatible = initial()
    compatible.update(loaded)
    compatible.setdefault("volunteers", [])
    compatible.setdefault("hazardSimInputs", {})
    compatible.setdefault("hazardAlerts", [])
    compatible.setdefault("hazardOutlook", {})
    for hazard in compatible["hazardAlerts"]:
        ensure_alert_fields(hazard)
    if SEED_HAZARD_DEMO and not compatible["hazardAlerts"]:
        seed_hazard_demo(compatible)
    compatible.setdefault("volunteerRequests", [])
    compatible["agents"] = {**initial()["agents"], **loaded.get("agents", {})}
    for event in compatible.get("events", []):
        legacy_type = event.get("ashraayeventtype") or event.get("type", "event")
        if legacy_type.startswith("org.ashraay."):
            legacy_type = legacy_type.removeprefix("org.ashraay.")
        event["ashraayeventtype"] = legacy_type
        event["type"] = f"org.ashraay.{legacy_type}"
        event.setdefault("specversion", "1.0")
        event.setdefault("source", "urn:ashraay:pilot-simulator")
        event.setdefault("datacontenttype", "application/json")
        event["traceid"] = event.pop("traceId", event.get("traceid", event.get("id") or trace()))
        event["jurisdictionid"] = event.pop("jurisdictionId", event.get("jurisdictionid", "IN-KL-EKM"))
        event["dataschema"] = event.pop(
            "dataSchema", event.get("dataschema", f"urn:ashraay:schema:{legacy_type}")
        )
        if event.get("subject") is None:
            event.pop("subject", None)
    S.update(compatible)
    persisted_state = copy.deepcopy(S)
    if RESET_ON_START:
        # Write the clean slate back so a later restart with resets disabled doesn't resurrect old data.
        await persist(reset_outbox=True)
    if auto_run["running"]:
        auto_run["startedAt"] = now()
    reliability_task = asyncio.create_task(reliability_worker())
    escalation_task = asyncio.create_task(volunteer_escalation_worker())
    simulation_agent_task = asyncio.create_task(simulation_agent_worker())
    try:
        yield
    finally:
        for task in (reliability_task, escalation_task, simulation_agent_task):
            task.cancel()
        for task in (reliability_task, escalation_task, simulation_agent_task):
            try:
                await task
            except asyncio.CancelledError:
                pass
        try:
            await persist()
        finally:
            await copilot_agent.shutdown()
            await dispose()


async def reliability_worker() -> None:
    while True:
        await asyncio.sleep(15)
        try:
            async with state_lock:
                dispatched = await dispatch_outbox(100, "simulator-observer", now())
                expired_plans = expire_pending_plans()
                expired_holds = expire_resource_holds()
                if expired_plans or expired_holds or dispatched["dispatched"]:
                    audit(
                        "reliability.scheduled_tick",
                        {
                            "expiredPlans": expired_plans,
                            "expiredResourceHolds": expired_holds,
                            "dispatched": dispatched["dispatched"],
                        },
                    )
                    await persist()
        except HTTPException:
            logger.exception("Scheduled simulator reliability work could not be persisted.")
        except SQLAlchemyError:
            logger.exception("Scheduled simulator reliability dispatch failed.")


async def simulation_agent_worker() -> None:
    """The live Hazard Intelligence agent: every 10 seconds it picks up new simulator inputs (Event
    Simulator + ASHRAAY Hazard Simulator) and new citizen reports/check-ins, raises or updates alerts and
    refreshes its recommendations. Location is never used to filter or rank anything."""
    while True:
        auto_run["nextTickAt"] = (
            datetime.now(timezone.utc) + timedelta(seconds=SIMULATION_SCAN_INTERVAL_SECONDS)
        ).isoformat()
        await asyncio.sleep(SIMULATION_SCAN_INTERVAL_SECONDS)
        if not auto_run["running"]:
            continue
        candidates: list[dict] = []
        if AGENT_READS_SIM_FEED:
            try:
                candidates = simulator_candidates(await fetch_snapshot())
                auto_run["simulatorNote"] = None
            except SimFeedError as exc:
                auto_run["simulatorNote"] = str(exc)
            except Exception as exc:  # never let the simulator stop the agent
                auto_run["simulatorNote"] = f"Hazard Simulator feed unreadable ({exc.__class__.__name__})."
        try:
            async with state_lock:
                changed = await agent_tick(candidates)
                auto_run["lastTickAt"] = now()
                auto_run["lastError"] = None
                if changed:
                    await persist()
        except Exception as exc:
            auto_run["lastError"] = str(exc)
            logger.exception("Live hazard agent tick failed.")


def active_hazard_alerts() -> list[dict]:
    return [
        item for item in S["hazardAlerts"]
        if item.get("approvalStatus") != "rejected" and item["status"] not in ("ignored", "resolved")
    ]


async def agent_scan_and_analyse(scan: HazardScanIn, key: str) -> dict | None:
    result = await hazard_scan(scan, _idempotency_key=key, _=None)
    alert_id = result.get("id")
    if not alert_id or result.get("status") == "existing":
        return None
    alert = next((item for item in S["hazardAlerts"] if item["id"] == alert_id), None)
    if alert and alert["status"] == "pending":
        await hazard_analyse(alert_id, _idempotency_key=f"{key}-analyse", _=None)
    auto_run["scans"] += 1
    return alert


def agent_note(alert: dict, text: str, recommendation: str) -> None:
    alert["agentUpdate"] = {"at": now(), "text": text, "recommendation": recommendation}


async def agent_tick(candidates: list[dict]) -> bool:
    changed = False
    budget = AGENT_MAX_NEW_SCANS_PER_TICK

    # Saved inputs remain authoritative even after their events age out or the API restarts.
    input_events = [event for event in S["events"] if event.get("ashraayeventtype") == SIMULATION_INPUT_EVENT]
    auto_run_seen_events.intersection_update({event["id"] for event in input_events})
    pending = [event for event in input_events if event["id"] not in auto_run_seen_events]
    latest_by_city: dict[str, dict] = {}
    for event in pending:
        city_id = event.get("data", {}).get("cityId")
        if city_id:
            latest_by_city[city_id] = event
    for city_id, sim_input in S["hazardSimInputs"].items():
        if city_id not in latest_by_city:
            latest_by_city[city_id] = {
                "id": f"saved-{city_id}-{sim_input['updatedAt']}",
                "time": sim_input["updatedAt"],
                "data": sim_input,
            }
    for city_id, event in latest_by_city.items():
        sim_input = S["hazardSimInputs"].get(city_id)
        if sim_input is None:
            auto_run_seen_events.update(
                item["id"] for item in pending if item.get("data", {}).get("cityId") == city_id
            )
            continue
        fp = live_agent.fingerprint(sim_input)
        source_key = f"input:{city_id}"
        if agent_seen_sources.get(source_key) == fp:
            continue
        coordinates = SIMULATION_CITY_COORDINATES.get(city_id, (None, None))
        place = city_id.replace("-", " ").title()
        existing = next((item for item in active_hazard_alerts() if item["cityId"] == city_id and not item.get("demoSeed")), None)
        if existing is not None:
            changed |= refresh_alert_signal(existing, sim_input["rain24Mm"], sim_input["floodRiskPct"], sim_input["reservoirFillPct"])
        else:
            await agent_scan_and_analyse(HazardScanIn(
                cityId=city_id, place=place, latitude=coordinates[0], longitude=coordinates[1],
                rain24Mm=sim_input["rain24Mm"], floodRiskPct=sim_input["floodRiskPct"],
                reservoirFillPct=sim_input["reservoirFillPct"],
            ), f"sim-{event['id']}")
        auto_run_seen_events.update(item["id"] for item in pending if item.get("data", {}).get("cityId") == city_id)
        auto_run["lastEventAt"] = event.get("time")
        agent_seen_sources[source_key] = fp
        changed = True

    # 2. ASHRAAY Hazard Simulator: every elevated source, highest risk first (never by distance).
    elevated = sorted(
        (item for item in candidates if item.get("severityRank", 0) >= 1),
        key=lambda item: (item["severityRank"], item["intensity"]), reverse=True,
    )
    auto_run["simulatorSources"] = len(elevated)
    for candidate in elevated:
        signal = {key: candidate.get(key) for key in ("rainMm", "rainWindowHours", "floodRiskPct", "reservoirFillPct", "status")}
        fp = live_agent.fingerprint(signal)
        if agent_seen_sources.get(candidate["cityId"]) == fp:
            continue
        existing = next((item for item in active_hazard_alerts() if item["cityId"] == candidate["cityId"]), None)
        if existing is not None:
            existing["rainWindowHours"] = candidate.get("rainWindowHours") or 24
            changed |= refresh_alert_signal(existing, candidate["rainMm"], candidate["floodRiskPct"], candidate["reservoirFillPct"])
            agent_seen_sources[candidate["cityId"]] = fp
            continue
        if budget <= 0:
            break
        budget -= 1
        alert = await agent_scan_and_analyse(HazardScanIn(
            cityId=candidate["cityId"], place=candidate["place"] or "Simulator source",
            latitude=candidate.get("latitude"), longitude=candidate.get("longitude"),
            rain24Mm=min(candidate["rainMm"] or 0, 2000), floodRiskPct=candidate["floodRiskPct"] or 0,
            landslideRiskPct=min(candidate.get("landslideRiskPct") or 0, 100),
            reservoirFillPct=candidate["reservoirFillPct"] or 0,
        ), f"simfeed-{candidate['cityId']}-{fp}")
        if alert is not None:
            source = candidate.get("source") or {}
            alert.update(
                rainWindowHours=candidate.get("rainWindowHours") or 24,
                rainSource="ASHRAAY Simulator",
                reservoirSource="ASHRAAY Simulator",
                simulated=True,
                sourceKind=source.get("kind"),
            )
            record_outlook(
                S, city_id=alert["cityId"], place=alert["place"], rain_mm=alert["rainMm"],
                rain_window_hours=alert["rainWindowHours"], reservoir_pct=alert["reservoirFillPct"],
                flood_risk_pct=alert["floodRiskPct"],
            )
        agent_seen_sources[candidate["cityId"]] = fp
        changed = True

    # 3. Citizen reports and check-ins from the mobile app (whole system, no location filter).
    signals = live_agent.citizen_signals(S)
    auto_run["citizenSignals"] = signals
    fp = live_agent.fingerprint(signals)
    if agent_user_fingerprint["value"] != fp:
        previous = agent_user_fingerprint["signals"]
        note = live_agent.update_note(signals, previous)
        agent_user_fingerprint.update(value=fp, signals=signals)
        changed |= sync_citizen_alert(signals)
        for alert in active_hazard_alerts():
            consolidated = alert.get("consolidated") or {}
            consolidated.update({
                "scope": "all",
                "totalIncidents": signals["openIncidents"],
                "approvedIncidents": signals["verifiedIncidents"],
                "pendingReviewIncidents": signals["openIncidents"] - signals["verifiedIncidents"],
                "peopleReported": signals["peopleReported"],
                "checkinsNeedHelp": signals["needHelp"],
                "checkinsAtRisk": signals["atRisk"],
                "checkinsSafe": signals["safe"],
                "analysedAt": now(),
            })
            alert["consolidated"] = consolidated
            if signals["needHelp"] >= 5 and alert.get("volunteersNeeded") is not None:
                alert["volunteersNeeded"] = max(alert["volunteersNeeded"], HAZARD_VOLUNTEERS_NEEDED["high"])
            if note:
                agent_note(alert, note["text"], note["recommendation"])
                auto_run["updates"] += 1
        changed = True
    return changed


def refresh_alert_signal(alert: dict, rain_mm: float, flood_pct: float, reservoir_pct: float) -> bool:
    """New reading for a source that already has an active alert: update evidence, and upgrade the
    severity + recommendations while the alert still waits for a human decision."""
    before = (alert.get("rainMm"), alert.get("floodRiskPct"), alert.get("reservoirFillPct"))
    after = (rain_mm, flood_pct, reservoir_pct)
    record_outlook(
        S, city_id=alert["cityId"], place=alert["place"], rain_mm=rain_mm,
        rain_window_hours=alert.get("rainWindowHours") or 24,
        reservoir_pct=reservoir_pct, flood_risk_pct=flood_pct,
    )
    if before == after:
        return True
    alert.update(rainMm=rain_mm, rain24Mm=rain_mm, floodRiskPct=flood_pct, reservoirFillPct=reservoir_pct,
                 signalUpdatedAt=now())
    probe = HazardScanIn(cityId=alert["cityId"], place=alert["place"], rain24Mm=rain_mm,
                         floodRiskPct=flood_pct, reservoirFillPct=reservoir_pct)
    severity = hazard_severity(probe)
    text = f"New reading: {round(rain_mm)} mm rain, reservoir {round(reservoir_pct)}%, flood risk {round(flood_pct)}%."
    if alert.get("approvalStatus") in (None, "awaiting_approval"):
        confidence = live_agent.rule_confidence(rain_mm, reservoir_pct, flood_pct, severity)
        actions = live_agent.rule_recommended_actions(alert["place"], severity, rain_mm, reservoir_pct)
        alert.update(
            severity=severity or "low",
            tier=tier_from_severity(severity or "low", confidence),
            confidencePct=round(confidence * 100),
            reasons=hazard_reasons(probe, severity) if severity else ["Simulated readings are below warning thresholds."],
            recommendedActions=actions,
            approvalStatus="awaiting_approval" if actions else None,
        )
        alert["summary"] = alert["reasons"][0]
        agent_note(alert, text, "Risk has risen - review the updated recommendations.")
    else:
        agent_note(alert, text, "Keep monitoring." if not severity else "Review whether the response is still enough.")
    auto_run["updates"] += 1
    return True


def sync_citizen_alert(signals: dict) -> bool:
    """One alert on the dashboard for citizen reports/check-ins, created or refreshed by the agent."""
    severity = live_agent.citizen_severity(signals)
    existing = next(
        (item for item in active_hazard_alerts() if item["cityId"] == live_agent.CITIZEN_ALERT_CITY_ID
         and not item.get("responseCompletedAt")), None
    )
    if severity is None:
        return False
    reasons = live_agent.citizen_reasons(signals)
    actions = live_agent.citizen_recommended_actions(signals)
    confidence = 0.8 if signals["verifiedIncidents"] or signals["needHelp"] >= 3 else 0.66
    fields = {
        "severity": severity,
        "tier": tier_from_severity(severity, confidence),
        "confidencePct": round(confidence * 100),
        "reasons": reasons,
        "summary": reasons[0],
        "recommendedActions": actions,
        "peopleReported": signals["peopleReported"],
        "checkinsNeedHelp": signals["needHelp"],
        "openIncidents": signals["openIncidents"],
        "updatedAt": now(),
    }
    if existing is not None:
        if existing.get("approvalStatus") != "awaiting_approval":
            return False
        existing.update(fields)
        return True
    alert = {
        "id": str(uuid4()),
        "cityId": live_agent.CITIZEN_ALERT_CITY_ID,
        "place": live_agent.CITIZEN_ALERT_PLACE,
        "latitude": None,
        "longitude": None,
        "rain24Mm": 0,
        "floodRiskPct": 0,
        "landslideRiskPct": 0,
        "reservoirFillPct": 0,
        **fields,
        "llmAssisted": False,
        "floodWindowHours": "",
        "approvalStatus": "awaiting_approval",
        "hazardType": "citizen",
        "area": live_agent.CITIZEN_ALERT_PLACE,
        "title": "People need help - citizen reports",
        "rainMm": 0,
        "rainWindowHours": 24,
        "rainSource": "Citizen app",
        "reservoirSource": "",
        "floodPeak": "",
        "revision": 1,
        "decisionLog": [],
        "approvedAt": None,
        "planApprovedAt": None,
        "responsePlan": [],
        "status": "analysed",
        "createdAt": now(),
        "consolidated": None,
        "volunteersNeeded": HAZARD_VOLUNTEERS_NEEDED[severity],
        "volunteerRounds": 0,
        "resolvedAt": None,
        "simulated": False,
    }
    S["hazardAlerts"].append(alert)
    audit("hazard.alert.created", {"hazardAlertId": alert["id"], "severity": severity, "tier": alert["tier"], "place": alert["place"]})
    record_event("hazard.alert.created.v1", {"hazardAlertId": alert["id"], "severity": severity, "place": alert["place"]})
    return True


app = FastAPI(title="ASHRAAY Pilot Simulator API", version="2.0.0", lifespan=lifespan)
origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://localhost:5174,http://localhost:5175"
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)
app.include_router(accounts_router)


@app.middleware("http")
async def serialize_simulator_requests(
    request: Request, call_next: RequestResponseEndpoint
) -> Response:
    if (
        request.url.path.startswith("/api/v1/")
        and request.url.path != "/api/v1/config"
        and not request.url.path.startswith("/api/v1/auth/")
    ):
        async with state_lock:
            return await call_next(request)
    return await call_next(request)


class ForecastIn(BaseModel):
    place: str = Field(min_length=2, max_length=120)
    rainfallMm: float = Field(ge=0, le=1000)
    riverLevelM: float = Field(ge=0, le=100)
    source: str = Field(min_length=2, max_length=120)


class ReportIn(BaseModel):
    description: str = Field(min_length=10, max_length=1000)
    landmark: str = Field(min_length=3, max_length=160)
    people: int = Field(ge=0, le=500)
    consent: bool
    source: Literal["citizen-app", "simulator", "community", "social"] = "citizen-app"
    incidentType: Literal["flood", "heavy-rain", "landslide", "other"] = "flood"
    needs: list[Literal["evacuation", "drinking-water", "medical", "food", "shelter"]] = Field(
        default_factory=list, max_length=5,
    )
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracyM: float | None = Field(default=None, ge=0, le=100000)


class CheckInIn(BaseModel):
    status: Literal["safe", "at_risk", "need_help"]
    landmark: str = Field(min_length=3, max_length=160)
    consent: bool
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracyM: float | None = Field(default=None, ge=0, le=100000)
    locationSource: Literal["gps", "map"] | None = None

    @model_validator(mode="after")
    def coordinates_paired(self) -> "CheckInIn":
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must be provided together.")
        return self


class SourceReportIn(ReportIn):
    source: Literal["community", "social", "simulator"] = "community"


class DecisionIn(BaseModel):
    action: Literal["approve", "modify", "reject", "escalate"]
    reason: str = Field(min_length=5, max_length=500)
    revision: int = Field(ge=1)
    modification: str | None = Field(default=None, max_length=500)


class ReviewIn(BaseModel):
    action: Literal["confirm", "dismiss"]
    reason: str = Field(default="Reviewed via Command Center.", max_length=500)


class ReportDecisionIn(BaseModel):
    action: Literal["approve", "discard"]


class ResponseChoiceIn(BaseModel):
    need: Literal["safe", "shelter", "preposition", "rescue", "boat", "other"]


class TaskTransitionIn(BaseModel):
    status: Literal["accepted", "declined", "on_site", "blocked", "completed"]
    peopleAssisted: int | None = Field(default=None, ge=0, le=500)
    note: str | None = Field(default=None, max_length=500)
    completionPhoto: str | None = Field(default=None, max_length=2_800_000)
    completionVoice: str | None = Field(default=None, max_length=2_800_000)

    @field_validator("completionVoice")
    @classmethod
    def validate_completion_voice(cls, value: str | None) -> str | None:
        if value is None:
            return None
        prefix, separator, encoded = value.partition(",")
        signatures = {
            "data:audio/webm;base64": (b"\x1a\x45\xdf\xa3",),
            "data:audio/ogg;base64": (b"OggS",),
            "data:audio/mpeg;base64": (b"ID3",),
            "data:audio/wav;base64": (b"RIFF",),
            "data:audio/mp4;base64": (),
        }
        if not separator or prefix not in signatures:
            raise ValueError("Voice note must be WebM, Ogg, MP3, WAV, or M4A audio.")
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Voice note contains invalid audio data.") from exc
        if not audio or len(audio) > 2 * 1024 * 1024:
            raise ValueError("Voice note must be at most 2 MB.")
        matches = any(audio.startswith(signature) for signature in signatures[prefix])
        if prefix == "data:audio/mpeg;base64":
            matches |= len(audio) >= 2 and audio[0] == 255 and audio[1] & 224 == 224
        elif prefix == "data:audio/mp4;base64":
            matches = audio[4:8] == b"ftyp"
        elif prefix == "data:audio/wav;base64":
            matches &= audio[8:12] == b"WAVE"
        if not matches:
            raise ValueError("Voice note does not match its audio type.")
        return value

    @model_validator(mode="after")
    def validate_completion_photo(self) -> "TaskTransitionIn":
        if self.completionPhoto is None:
            return self
        prefix, separator, encoded = self.completionPhoto.partition(",")
        if not separator or prefix not in ("data:image/jpeg;base64", "data:image/png;base64"):
            raise ValueError("Completion photo must be a JPEG or PNG image.")
        try:
            image = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Completion photo contains invalid image data.") from exc
        if not image or len(image) > 2 * 1024 * 1024:
            raise ValueError("Completion photo must be at most 2 MB.")
        signature = b"\xff\xd8\xff" if "jpeg" in prefix else b"\x89PNG\r\n\x1a\n"
        if not image.startswith(signature):
            raise ValueError("Completion photo does not match its image type.")
        return self


class AlertIn(BaseModel):
    place: str = Field(min_length=2, max_length=120)
    message: str = Field(min_length=10, max_length=1000)
    language: Literal["en", "hi", "ta", "ml", "kn"] = "en"


VolunteerSkill = Literal[
    "rescue", "first-aid", "boat-handling", "swimming", "driving", "logistics", "counselling", "translation",
]


class VolunteerIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    displayName: str = Field(min_length=2, max_length=80)
    skills: list[VolunteerSkill] = Field(min_length=1, max_length=8)
    languages: list[Literal["en", "hi", "ta", "ml", "kn"]] = Field(min_length=1, max_length=5)
    area: str = Field(min_length=3, max_length=120)
    consent: bool


class AvailabilityIn(BaseModel):
    available: bool


class VolunteerVerifyIn(BaseModel):
    action: Literal["verify", "reject"]
    reason: str = Field(min_length=5, max_length=500)


HazardSeverity = Literal["low", "medium", "high"]

# Volunteers dispatched for the first round of a hazard alert, by severity.
HAZARD_VOLUNTEERS_NEEDED: dict[HazardSeverity, int] = {"low": 2, "medium": 5, "high": 10}
# How long every active volunteer has to accept or decline a dispatched hazard alert.
VOLUNTEER_RESPONSE_TIMEOUT_SECONDS = int(os.getenv("ASHRAAY_VOLUNTEER_RESPONSE_SECONDS", "1800"))


class HazardScanIn(BaseModel):
    """Agent 1 input: the weather/geo signals the dashboard already computes for the selected city."""

    cityId: str = Field(min_length=1, max_length=40)
    place: str = Field(min_length=2, max_length=120)
    # Display-only: never used to filter, rank or target alerts or volunteers.
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    rain24Mm: float = Field(ge=0, le=2000)
    floodRiskPct: float = Field(ge=0, le=100, default=0)
    landslideRiskPct: float = Field(ge=0, le=100, default=0)
    reservoirFillPct: float = Field(ge=0, le=100, default=0)


class HazardSimulationIn(BaseModel):
    """Values the simulation website can set for a city, overriding the live weather feed for Agent 1."""

    cityId: str = Field(min_length=1, max_length=40)
    rain24Mm: float = Field(ge=0, le=2000)
    floodRiskPct: float = Field(ge=0, le=100, default=0)
    reservoirFillPct: float = Field(ge=0, le=100)


class VolunteerRequestRespondIn(BaseModel):
    available: bool


class HazardAlertActionIn(BaseModel):
    """Optional edited recommended actions from the Agent Intelligence panel's "Modify" flow."""

    actions: list[dict] | None = Field(default=None, max_length=6)


def hazard_severity(body: HazardScanIn) -> HazardSeverity | None:
    """Mirrors the flood-risk thresholds already used client-side in dashboard.js for consistency."""
    rain, reservoir, flood_risk = body.rain24Mm, body.reservoirFillPct, body.floodRiskPct
    if rain >= 115 or (rain >= 64.5 and reservoir >= 85) or (reservoir >= 95 and rain >= 15):
        return "high"
    if rain >= 64.5 or (rain >= 15 and reservoir >= 80) or reservoir >= 92 or flood_risk >= 70:
        return "medium"
    return None


def hazard_reasons(body: HazardScanIn, severity: HazardSeverity) -> list[str]:
    reasons = []
    if body.rain24Mm >= 1:
        reasons.append(f"{round(body.rain24Mm)} mm of rain is forecast in the next 24 hours near {body.place}.")
    if body.reservoirFillPct >= 80:
        reasons.append(
            f"The dam/reservoir near {body.place} is already at {round(body.reservoirFillPct)}% capacity, "
            "leaving little buffer for more inflow."
        )
    if body.floodRiskPct >= 50:
        reasons.append(f"The 72-hour flood risk index is {round(body.floodRiskPct)}%.")
    if severity == "high":
        reasons.append("Continuous heavy rain combined with a near-full reservoir raises the chance of flooding downstream.")
    return reasons or [f"Rain, river or reservoir readings near {body.place} crossed a warning threshold."]


async def copilot_sdk_token_or_raise() -> str:
    """Returns the configured Copilot token, or raises a clear 422 if copilot-sdk mode has none set."""
    settings = await get_llm_settings_with_token()
    token = (settings.get("githubToken") or "").strip()
    if not token:
        raise HTTPException(
            422,
            detail="Copilot SDK mode is enabled but no GitHub token is configured in Agent language model settings.",
        )
    return token


def copilot_sdk_model_or_raise(settings: dict) -> str:
    """Returns the configured Copilot model, or raises a clear 422 if copilot-sdk mode has none chosen."""
    model = (settings.get("llmModel") or "").strip()
    if not model or model == "n/a":
        raise HTTPException(
            422,
            detail="Copilot SDK mode is enabled but no model is chosen. List and pick one in Agent language model settings.",
        )
    return model


def rules_hazard_scan_judgement(
    body: HazardScanIn, rule_severity: HazardSeverity | None, rule_reasons: list[str]
) -> tuple[HazardSeverity | None, list[str], bool, float, str, list[dict]]:
    """Agent 1 without a language model: deterministic severity, confidence and recommendations."""
    confidence = live_agent.rule_confidence(body.rain24Mm, body.reservoirFillPct, body.floodRiskPct, rule_severity)
    actions = live_agent.rule_recommended_actions(body.place, rule_severity, body.rain24Mm, body.reservoirFillPct)
    return rule_severity, rule_reasons, False, confidence, live_agent.rule_flood_window(rule_severity), actions


async def apply_copilot_hazard_scan_judgement(
    body: HazardScanIn, rule_severity: HazardSeverity | None, rule_reasons: list[str]
) -> tuple[HazardSeverity | None, list[str], bool, float, str, list[dict]]:
    """Lets Agent 1's Copilot judgement decide the final severity/reasons, using the rule-based
    result only as context. Raises HTTPException(502) if the Copilot SDK call fails."""
    settings = await get_llm_settings()
    try:
        token = await copilot_sdk_token_or_raise()
        model = copilot_sdk_model_or_raise(settings)
    except HTTPException:
        return rules_hazard_scan_judgement(body, rule_severity, rule_reasons)
    try:
        judgement = await copilot_agent.judge_hazard_scan(
            place=body.place,
            rain24_mm=body.rain24Mm,
            flood_risk_pct=body.floodRiskPct,
            landslide_risk_pct=body.landslideRiskPct,
            reservoir_fill_pct=body.reservoirFillPct,
            rule_severity=rule_severity,
            rule_reasons=rule_reasons,
            token=token,
            model=model,
        )
    except CopilotJudgementError as exc:
        logger.warning("Copilot hazard scan failed; using built-in rules instead: %s", exc)
        return rules_hazard_scan_judgement(body, rule_severity, rule_reasons)
    severity = None if judgement.severity == "none" else judgement.severity
    actions = [action.model_dump() for action in judgement.recommended_actions]
    return severity, judgement.reasons, True, judgement.confidence, judgement.flood_window_hours, actions


async def apply_copilot_hazard_analyse_judgement(
    *,
    place: str,
    scope: str,
    rule_severity: HazardSeverity,
    total_incidents: int,
    approved_incidents: int,
    pending_review_incidents: int,
    people_reported: int,
    checkins_need_help: int,
    checkins_at_risk: int,
    checkins_safe: int,
    rule_volunteers_needed: int,
) -> tuple[HazardSeverity, int, list[str] | None, bool]:
    """Lets Agent 2's Copilot judgement decide the final severity/volunteer count, using the rule-based
    result only as context. Raises HTTPException(502) if the Copilot SDK call fails."""
    settings = await get_llm_settings()
    try:
        token = await copilot_sdk_token_or_raise()
        model = copilot_sdk_model_or_raise(settings)
    except HTTPException:
        return rule_severity, rule_volunteers_needed, None, False
    try:
        judgement = await copilot_agent.judge_hazard_analyse(
            place=place,
            scope=scope,
            severity=rule_severity,
            total_incidents=total_incidents,
            approved_incidents=approved_incidents,
            pending_review_incidents=pending_review_incidents,
            people_reported=people_reported,
            checkins_need_help=checkins_need_help,
            checkins_at_risk=checkins_at_risk,
            checkins_safe=checkins_safe,
            rule_volunteers_needed=rule_volunteers_needed,
            token=token,
            model=model,
        )
    except CopilotJudgementError as exc:
        logger.warning("Copilot hazard analysis failed; using built-in rules instead: %s", exc)
        return rule_severity, rule_volunteers_needed, None, False
    return judgement.severity, judgement.volunteers_needed, judgement.reasons, True


async def apply_copilot_dispatch_judgement(
    *, alert: dict, candidates: list[dict], still_needed: int
) -> tuple[list[dict], list[str] | None, bool]:
    """Lets Agent 3's Copilot judgement choose/reorder which candidates to dispatch first.

    Returns (picked, reasons, llmAssisted). Raises HTTPException(502) if the Copilot SDK call fails
    or returns no usable picks."""
    settings = await get_llm_settings()
    token = await copilot_sdk_token_or_raise()
    model = copilot_sdk_model_or_raise(settings)
    pool = candidates[: max(still_needed * 3, still_needed)]
    try:
        judgement = await copilot_agent.judge_dispatch_selection(
            place=alert["place"],
            severity=alert["severity"],
            still_needed=still_needed,
            candidates=pool,
            token=token,
            model=model,
        )
    except CopilotJudgementError as exc:
        raise HTTPException(502, detail=str(exc)) from exc
    by_id = {item["id"]: item for item in pool}
    picked = [by_id[selected_id] for selected_id in judgement.selected_ids if selected_id in by_id][:still_needed]
    if not picked:
        raise HTTPException(502, detail="Copilot dispatch judgement did not select any valid candidates.")
    return picked, judgement.reasons, True


def find_hazard_alert(hazard_id: str) -> dict:
    alert = next((item for item in S["hazardAlerts"] if item["id"] == hazard_id), None)
    if alert is None:
        raise HTTPException(404, detail="Hazard alert not found.")
    return alert


def eligible_volunteers(exclude_subjects: set[str]) -> list[dict]:
    """Every verified, available volunteer not asked yet. Location is never used to pick or order them."""
    return [
        item for item in live_agent.active_volunteers(S["volunteers"])
        if item["subject"] not in exclude_subjects
    ]


async def hazard_volunteers(exclude_subjects: set[str]) -> list[dict]:
    """Registered volunteers can join simulated hazard tasks without profile verification."""
    candidates = {
        profile["subject"]: profile for profile in S["volunteers"]
        if profile["status"] == "verified"
    }
    async with sessions() as session:
        accounts = (await session.scalars(
            select(UserAccount).where(UserAccount.role == "volunteer")
        )).all()
        for account in accounts:
            profile = find_volunteer(account.id)
            if profile and profile["status"] in ("withdrawn", "rejected"):
                continue
            candidates[account.id] = {
                "id": profile["id"] if profile else account.id,
                "subject": account.id,
                "displayName": (profile or {}).get("displayName") or account.name or f"Volunteer {account.id[:8]}",
                "available": profile["available"] if profile else True,
            }
    return [item for subject, item in candidates.items() if subject not in exclude_subjects]


def dispatch_round(alert: dict, picked: list[dict]) -> None:
    alert["volunteerRounds"] += 1
    round_no = alert["volunteerRounds"]
    created_at = now()
    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=VOLUNTEER_RESPONSE_TIMEOUT_SECONDS)
    ).isoformat()
    for item in picked:
        S["volunteerRequests"].append({
            "id": str(uuid4()),
            "hazardAlertId": alert["id"],
            "subject": item["subject"],
            "volunteerId": item["id"],
            "volunteerName": item["displayName"],
            "distanceKm": None,
            "round": round_no,
            "status": "pending",
            "createdAt": created_at,
            "expiresAt": expires_at,
            "respondedAt": None,
        })
    alert["status"] = "dispatched"
    alert["volunteersAsked"] = alert.get("volunteersAsked", 0) + len(picked)
    audit("hazard.volunteers.dispatched", {"hazardAlertId": alert["id"], "round": round_no, "count": len(picked)})
    record_event(
        "hazard.volunteers.dispatched.v1",
        {"hazardAlertId": alert["id"], "round": round_no, "count": len(picked)},
    )


def public_volunteer_request(item: dict) -> dict:
    return {key: value for key, value in item.items() if key != "subject"}


def latest_plan(plan_id: str) -> dict | None:
    revisions = [plan for plan in S["plans"] if plan["planId"] == plan_id]
    return max(revisions, key=lambda plan: plan["revision"]) if revisions else None


def create_plan(
    kind: str,
    summary: str,
    confidence: float,
    *,
    incident_id: str | None = None,
    source_id: str | None = None,
) -> dict:
    trace_id = trace()
    plan = {
        "id": str(uuid4()),
        "planId": str(uuid4()),
        "revision": 1,
        "kind": kind,
        "status": "pending",
        "summary": summary,
        "confidence": confidence,
        "checkRequired": confidence < 0.8,
        "evidenceRefs": [source_id or incident_id] if (source_id or incident_id) else [],
        "assumptions": ["Deterministic backup-rules output; human review is required."],
        "schemaVersion": "1.0",
        "modelVersion": "rules-v1",
        "traceId": trace_id,
        "incidentId": incident_id,
        "sourceId": source_id,
        "createdAt": now(),
    }
    S["plans"].append(plan)
    record_event("plan.proposed.v1", plan, trace_id)
    return plan


def release_reservations(plan_id: str, revision: int, reason: str) -> None:
    for reservation in S["reservations"]:
        if (
            reservation["planId"] == plan_id
            and reservation["revision"] == revision
            and reservation["status"] in {"held", "committed"}
        ):
            reservation.update(status="released", releasedAt=now(), releaseReason=reason)


def hold_resources(plan: dict) -> None:
    held_ids = {
        item["resourceId"]
        for item in S["reservations"]
        if item["status"] in {"held", "committed"}
    }
    selected = []
    unmet = []
    required = ["response-team", "boat"]
    for kind in required:
        resource = next(
            (
                item
                for item in S["resources"]
                if item["kind"] == kind
                and item["status"] == "available"
                and item["id"] not in held_ids
            ),
            None,
        )
        if resource is None:
            unmet.append(kind)
            continue
        selected.append(resource)
        held_ids.add(resource["id"])
        S["reservations"].append(
            {
                "id": str(uuid4()),
                "planId": plan["planId"],
                "revision": plan["revision"],
                "resourceId": resource["id"],
                "resourceName": resource["name"],
                "kind": resource["kind"],
                "status": "held",
                "createdAt": now(),
                "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
            }
        )
    plan["heldResources"] = [item["name"] for item in selected]
    plan["unmetNeeds"] = unmet
    plan["caveats"] = [
        f"No available {kind}; obtain alternate resources before approval."
        for kind in unmet
    ]
    record_event(
        "resource.reserved.v1",
        {
            "planId": plan["planId"],
            "revision": plan["revision"],
            "resources": plan["heldResources"],
            "unmetNeeds": unmet,
        },
    )


def expire_resource_holds() -> int:
    current_time = datetime.now(timezone.utc)
    expired_plans: set[tuple[str, int]] = set()
    for reservation in S["reservations"]:
        if reservation["status"] != "held":
            continue
        expires_at = datetime.fromisoformat(reservation["expiresAt"])
        if expires_at <= current_time:
            reservation.update(status="released", releasedAt=now(), releaseReason="hold expired")
            expired_plans.add((reservation["planId"], reservation["revision"]))
    for plan_id, revision in expired_plans:
        plan = next(
            (
                item
                for item in S["plans"]
                if item["planId"] == plan_id and item["revision"] == revision
            ),
            None,
        )
        if plan and plan["status"] in {"pending", "escalated"}:
            plan["status"] = "expired"
            record_event(
                "plan.expired.v1",
                {"planId": plan_id, "revision": revision},
            )
    return len(expired_plans)


def expire_pending_plans() -> int:
    current_time = datetime.now(timezone.utc)
    expired = 0
    for plan in S["plans"]:
        if plan["status"] not in {"pending", "escalated"}:
            continue
        if datetime.fromisoformat(plan["createdAt"]) + timedelta(minutes=15) > current_time:
            continue
        plan["status"] = "expired"
        release_reservations(plan["planId"], plan["revision"], "plan expired")
        record_event(
            "plan.expired.v1",
            {"planId": plan["planId"], "revision": plan["revision"]},
        )
        expired += 1
    return expired


async def add_forecast(body: ForecastIn, key: str) -> dict:
    old = next((item for item in S["forecasts"] if item["key"] == key), None)
    if old:
        if old["requestHash"] != request_hash(body):
            raise HTTPException(409, detail="Idempotency key was already used with a different request.")
        return old
    risk = "high" if body.rainfallMm >= 100 or body.riverLevelM >= 3 else (
        "moderate" if body.rainfallMm >= 50 or body.riverLevelM >= 2 else "low"
    )
    forecast = {
        "id": str(uuid4()),
        "key": key,
        "requestHash": request_hash(body),
        **body.model_dump(),
        "risk": risk,
        "confidence": 0.70,
        "checkRequired": True,
        "confidenceBasis": "Deterministic backup rules; confidence is capped at 0.70.",
        "time": now(),
        "label": "simulated",
    }
    S["forecasts"].append(forecast)
    record_event(
        "forecast.ingested.v1",
        {key: value for key, value in forecast.items() if key not in {"key", "requestHash"}},
    )
    if risk in {"high", "moderate"}:
        create_plan(
            "readiness",
            f"Prepare shelters and check response-team availability for {body.place}. "
            f"Forecast risk is {risk}; source: {body.source}.",
            forecast["confidence"],
            source_id=forecast["id"],
        )
    if risk == "high":
        create_plan(
            "warning",
            f"High flood risk for {body.place}: {body.rainfallMm:g} mm rain forecast. "
            f"Source: {body.source}. Issue an advisory only after approval.",
            forecast["confidence"],
            source_id=forecast["id"],
        )
    audit("forecast.ingested", {"forecastId": forecast["id"], "risk": risk})
    S["agents"]["a2"].update(status="healthy", lastRun=now())
    return forecast


async def add_report(body: ReportIn, key: str, principal: Principal) -> dict:
    old = next((item for item in S["reports"] if item["key"] == key), None)
    if old:
        if old["requestHash"] != request_hash(body):
            raise HTTPException(409, detail="Idempotency key was already used with a different request.")
        if old.get("owner") != principal.subject and not principal.has_any(
            "incident-commander", "verifier", "platform-admin"
        ):
            raise HTTPException(403, detail="This idempotency key belongs to another user.")
        return old
    if not body.consent:
        raise HTTPException(422, detail="Consent is required before submitting a report.")
    report = {
        "id": str(uuid4()),
        "caseId": f"ASH-{len(S['reports']) + 1:04d}",
        "key": key,
        "requestHash": request_hash(body),
        **body.model_dump(),
        "owner": principal.subject,
        "status": "received",
        "time": now(),
    }
    S["reports"].append(report)
    consent = {
        "id": str(uuid4()),
        "subject": principal.subject,
        "resourceId": report["id"],
        "purpose": "response-coordination",
        "channel": body.source,
        "grantedAt": report["time"],
        "withdrawnAt": None,
    }
    S["consents"].append(consent)
    record_event("observation.received.v1", {"reportId": report["id"], "source": body.source})
    audit("observation.received", {"caseId": report["caseId"]})
    return report


def has_active_consent(incident: dict) -> bool:
    report_ids = set(incident.get("reportIds", []))
    for report in S["reports"]:
        if report["id"] not in report_ids or report.get("consentWithdrawnAt"):
            continue
        consent = next(
            (
                item
                for item in S["consents"]
                if item["resourceId"] == report["id"]
                and item["purpose"] == "response-coordination"
            ),
            None,
        )
        if consent is None or consent.get("withdrawnAt") is None:
            return True
    return False


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/v1/config")
def client_config() -> dict:
    return {
        "issuer": os.getenv("OIDC_ISSUER", "http://localhost:8080/realms/ashraay"),
        "clientId": os.getenv("OIDC_CLIENT_ID", "ashraay-web"),
        "apiAudience": os.getenv("OIDC_AUDIENCE", "ashraay-api"),
        "scopes": os.getenv("OIDC_SCOPES", "openid profile email"),
    }


@app.get("/api/v1/state")
def state(
    principal: Principal = Depends(
        require_roles("incident-commander", "verifier", "platform-admin")
    ),
) -> dict:
    snapshot = copy.deepcopy(S)
    if principal.has_any("platform-admin") and not principal.has_any(
        "incident-commander", "verifier"
    ):
        for collection in (
            "forecasts",
            "reports",
            "checkins",
            "incidents",
            "reviews",
            "plans",
            "tasks",
            "deliveries",
            "reservations",
            "consents",
            "volunteers",
            "hazardAlerts",
            "volunteerRequests",
        ):
            snapshot[collection] = []
        snapshot["events"] = [
            {key: event[key] for key in ("id", "type", "time", "traceid", "status")}
            for event in snapshot["events"]
        ]
    for collection in ("reports", "forecasts", "checkins"):
        for item in snapshot[collection]:
            item.pop("key", None)
            item.pop("requestHash", None)
            if collection == "reports":
                item.pop("owner", None)
            if collection == "checkins":
                item.pop("owner", None)
    for plan in snapshot["plans"]:
        plan.pop("_alertIdempotency", None)
    for volunteer in snapshot.get("volunteers", []):
        volunteer.pop("subject", None)
    for request in snapshot.get("volunteerRequests", []):
        request.pop("subject", None)
    for task in snapshot["tasks"]:
        for key in ("offeredTo", "recipientSubjects", "declinedBy", "confirmedBy", "safetyAcknowledgements"):
            task.pop(key, None)
    snapshot.pop("consents", None)
    return snapshot


@app.get("/api/v1/events")
def events(
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> list[dict]:
    result = copy.deepcopy(list(reversed(S["events"][-limit:])))
    if principal.has_any("platform-admin") and not principal.has_any(
        "incident-commander", "verifier"
    ):
        for event in result:
            event.pop("data", None)
    return result


@app.get("/api/v1/agent-log")
async def agent_log(
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> list[dict]:
    content_allowed = principal.has_any("incident-commander", "verifier")
    return await agent_log_snapshot(limit, include_content=content_allowed)


@app.get("/api/v1/agent-status")
async def agent_status(
    _: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> list[dict]:
    return await agent_status_snapshot(int(datetime.now(timezone.utc).timestamp() * 1000))


@app.get("/api/v1/ops/reliability")
async def reliability(
    _: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    return await outbox_snapshot()


@app.post("/api/v1/ops/reliability/dispatch")
async def reliability_dispatch(
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    result = await dispatch_outbox(limit, "simulator-observer", now())
    audit("outbox.dispatched", {"count": result["dispatched"]})
    record_event("outbox.dispatched.v1", {"count": result["dispatched"]})
    await persist()
    return result


@app.post("/api/v1/ops/reliability/sweep")
async def reliability_sweep(
    _: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    expired_plans = expire_pending_plans()
    expired_holds = expire_resource_holds()
    if expired_plans or expired_holds:
        audit(
            "plans.expired",
            {"plans": expired_plans, "resourceHolds": expired_holds},
        )
        await persist()
    return {"expiredPlans": expired_plans, "expiredResourceHolds": expired_holds}


@app.post("/api/v1/ops/reliability/{event_id}/simulate-failure")
async def reliability_simulate_failure(
    event_id: str,
    principal: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    result = await fail_outbox_event(event_id, "Simulated transient consumer failure.")
    if result is None:
        raise HTTPException(404, detail="Outbox event not found.")
    if result["status"] == "pending":
        audit("outbox.attempt_failed", {"eventId": event_id, "attempts": result["attempts"]})
    elif result["status"] == "dead_letter":
        audit("outbox.dead_lettered", {"eventId": event_id, "attempts": result["attempts"]})
        record_event("delivery.failed.v1", {"eventId": event_id, "attempts": result["attempts"]})
    await persist()
    return result


@app.post("/api/v1/ops/reliability/{event_id}/replay")
async def reliability_replay(
    event_id: str,
    _: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    result = await replay_outbox_event(event_id)
    if result is None:
        raise HTTPException(404, detail="Outbox event not found.")
    if result["status"] == "pending":
        audit("outbox.replayed", {"eventId": event_id})
        record_event("delivery.replayed.v1", {"eventId": event_id})
        await persist()
    return result


def reporter_view(item: dict) -> dict:
    """The reporter's own record plus whether a responder has accepted the approved task."""
    view = {key: value for key, value in item.items() if key not in {"owner", "key", "requestHash"}}
    relevant_tasks = [
        task for task in S["tasks"]
        if (item.get("incidentId") and task.get("incidentId") == item["incidentId"])
        or item["id"] in task.get("reportIds", [])
    ]
    view["helpOnTheWay"] = any(
        task["status"] in {"accepted", "on_site", "awaiting_confirmation"}
        and item.get("owner") not in task.get("confirmedBy", [])
        for task in relevant_tasks
    )
    view["volunteerName"] = next(
        (task.get("volunteerName") for task in relevant_tasks
         if task["status"] in {"accepted", "on_site", "awaiting_confirmation"}
         and item.get("owner") not in task.get("confirmedBy", [])), None
    )
    return view


@app.get("/api/v1/my/reports")
def my_reports(principal: Principal = Depends(verify_token)) -> list[dict]:
    return [
        reporter_view(item)
        for item in reversed(S["reports"])
        if item.get("owner") == principal.subject
    ]


@app.get("/api/v1/privacy/export")
def privacy_export(principal: Principal = Depends(verify_token)) -> dict:
    return {
        "subject": principal.subject,
        "reports": [
            {
                key: value
                for key, value in item.items()
                if key not in {"owner", "key", "requestHash"}
            }
            for item in S["reports"]
            if item.get("owner") == principal.subject
        ],
        "checkins": [
            {
                key: value
                for key, value in item.items()
                if key not in {"owner", "key", "requestHash"}
            }
            for item in S["checkins"]
            if item.get("owner") == principal.subject
        ],
        "consents": [
            {key: value for key, value in item.items() if key != "subject"}
            for item in S["consents"]
            if item.get("subject") == principal.subject
        ],
        "volunteerProfile": public_volunteer(find_volunteer(principal.subject)),
    }


@app.post("/api/v1/privacy/consents/{consent_id}/withdraw")
async def withdraw_consent(
    consent_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(verify_token),
) -> dict:
    consent = next((item for item in S["consents"] if item["id"] == consent_id), None)
    if consent is None:
        raise HTTPException(404, detail="Consent record not found.")
    if consent["subject"] != principal.subject:
        raise HTTPException(403, detail="You may only withdraw your own consent.")
    if consent["withdrawnAt"] is None:
        consent["withdrawnAt"] = now()
        report = next(
            (item for item in S["reports"] if item["id"] == consent["resourceId"]),
            None,
        )
        if report:
            report["consentWithdrawnAt"] = consent["withdrawnAt"]
            report["statusBeforeConsentWithdrawal"] = report["status"]
            report["status"] = "consent_withdrawn"
            incident = next(
                (
                    item
                    for item in S["incidents"]
                    if report["id"] in item.get("reportIds", [])
                ),
                None,
            )
            if incident and not has_active_consent(incident):
                incident["status"] = "needs_review"
                for plan in S["plans"]:
                    if (
                        plan.get("incidentId") == incident["id"]
                        and plan["kind"] == "rescue"
                        and plan["status"] in {"pending", "escalated"}
                    ):
                        plan["status"] = "withdrawn"
                        release_reservations(
                            plan["planId"], plan["revision"], "supporting consent withdrawn"
                        )
                review = next(
                    (item for item in S["reviews"] if item["incidentId"] == incident["id"]),
                    None,
                )
                if review:
                    review["status"] = "pending"
                    review["reason"] = "Consent withdrawn; reverify evidence before further planning."
                else:
                    S["reviews"].append(
                        {
                            "id": str(uuid4()),
                            "incidentId": incident["id"],
                            "status": "pending",
                            "reason": "Consent withdrawn; reverify evidence before further planning.",
                            "createdAt": now(),
                        }
                    )
                record_event("review.requested.v1", {"incidentId": incident["id"]})
                record_event("incident.updated.v1", incident)
        checkin = next(
            (item for item in S["checkins"] if item["id"] == consent["resourceId"]),
            None,
        )
        if checkin:
            checkin["consentWithdrawnAt"] = consent["withdrawnAt"]
            checkin["status"] = "consent_withdrawn"
            checkin["landmark"] = ""
            for key in ("latitude", "longitude", "accuracyM", "locationSource"):
                checkin[key] = None
        audit("consent.withdrawn", {"consentId": consent_id})
        record_event("consent.withdrawn.v1", {"consentId": consent_id})
        await persist()
    return {key: value for key, value in consent.items() if key != "subject"}


def find_volunteer(subject: str) -> dict | None:
    return next((item for item in S["volunteers"] if item["subject"] == subject), None)


def public_volunteer(profile: dict | None) -> dict | None:
    if profile is None:
        return None
    return {key: value for key, value in profile.items() if key != "subject"}


def is_pure_volunteer(principal: Principal) -> bool:
    return "volunteer" in principal.roles and not principal.has_any("field-team", "response-agency")


def volunteer_may_work(principal: Principal) -> bool:
    """A volunteer needs a verified profile and must have marked themselves available."""
    profile = find_volunteer(principal.subject)
    return bool(profile and profile["status"] == "verified" and profile["available"])


@app.get("/api/v1/my/tasks")
def my_tasks(
    principal: Principal = Depends(
        require_roles("volunteer", "field-team", "response-agency")
    ),
) -> list[dict]:
    may_see_offers = not is_pure_volunteer(principal) or volunteer_may_work(principal)
    return [
        public_field_task(item)
        for item in S["tasks"]
        if item.get("assignee") == principal.subject
        or (
            item.get("assignee") is None
            and (
                principal.subject in item.get("offeredTo", []) if item.get("hazardAlertId")
                else may_see_offers
            )
            and principal.subject not in item.get("declinedBy", [])
        )
    ]


@app.get("/api/v1/volunteers/me")
def my_volunteer_profile(
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> dict:
    profile = public_volunteer(find_volunteer(principal.subject))
    return {"enrolled": profile is not None and profile["status"] != "withdrawn", "profile": profile}


@app.post("/api/v1/volunteers/me")
async def enrol_volunteer(
    body: VolunteerIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> dict:
    if not body.consent:
        raise HTTPException(422, detail="Consent is required to share your volunteer profile with the response team.")
    profile = find_volunteer(principal.subject)
    fields = {
        "displayName": body.displayName.strip(),
        "skills": sorted(set(body.skills)),
        "languages": sorted(set(body.languages)),
        "area": body.area.strip(),
    }
    if profile is None:
        profile = {
            "id": f"V-{len(S['volunteers']) + 1:03d}",
            "subject": principal.subject,
            **fields,
            "available": False,
            "status": "pending",
            "enrolledAt": now(),
            "verifiedBy": None,
            "verifiedAt": None,
        }
        S["volunteers"].append(profile)
    else:
        changed = any(profile[key] != value for key, value in fields.items())
        profile.update(fields)
        if profile["status"] == "withdrawn" or (changed and profile["status"] == "verified"):
            profile.update(status="pending", available=False, verifiedBy=None, verifiedAt=None)
    audit("volunteer.enrolled", {"volunteerId": profile["id"]})
    record_event("volunteer.enrolled.v1", {"volunteerId": profile["id"], "status": profile["status"]})
    await persist()
    return public_volunteer(profile)


@app.post("/api/v1/volunteers/me/availability")
async def set_volunteer_availability(
    body: AvailabilityIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> dict:
    profile = find_volunteer(principal.subject)
    if profile is None or profile["status"] == "withdrawn":
        raise HTTPException(409, detail="Enrol as a volunteer before setting availability.")
    if body.available and profile["status"] != "verified":
        raise HTTPException(409, detail="Your profile must be verified by the response team before you can be available for tasks.")
    profile["available"] = body.available
    audit("volunteer.availability", {"volunteerId": profile["id"], "available": body.available})
    await persist()
    return public_volunteer(profile)


@app.post("/api/v1/volunteers/me/withdraw")
async def withdraw_volunteer(
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> dict:
    profile = find_volunteer(principal.subject)
    if profile is None:
        raise HTTPException(404, detail="You are not enrolled as a volunteer.")
    profile.update(status="withdrawn", available=False)
    audit("volunteer.withdrawn", {"volunteerId": profile["id"]})
    await persist()
    return public_volunteer(profile)


@app.get("/api/v1/volunteers")
def list_volunteers(
    _: Principal = Depends(require_roles("incident-commander", "verifier")),
) -> list[dict]:
    return [public_volunteer(item) for item in S["volunteers"] if item["status"] != "withdrawn"]


@app.post("/api/v1/volunteers/{volunteer_id}/verify")
async def verify_volunteer(
    volunteer_id: str,
    body: VolunteerVerifyIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("incident-commander", "verifier")),
) -> dict:
    profile = next((item for item in S["volunteers"] if item["id"] == volunteer_id), None)
    if profile is None:
        raise HTTPException(404, detail="Volunteer not found.")
    if profile["status"] == "withdrawn":
        raise HTTPException(409, detail="This volunteer withdrew their enrolment.")
    profile.update(
        status="verified" if body.action == "verify" else "rejected",
        available=profile["available"] and body.action == "verify",
        verifiedBy=principal.subject,
        verifiedAt=now(),
    )
    audit(f"volunteer.{body.action}", {"volunteerId": volunteer_id, "reason": body.reason})
    record_event("volunteer.verified.v1", {"volunteerId": volunteer_id, "status": profile["status"]})
    await persist()
    return public_volunteer(profile)


HAZARD_ROLES = ("incident-commander", "verifier")


@app.get("/api/v1/simulator/hazard-inputs")
def list_hazard_sim_inputs() -> dict:
    """Public: the simulation website reads this to show what currently drives Agent 1 for each city."""
    return S["hazardSimInputs"]


@app.get("/api/v1/simulator/sim-feed")
async def read_simulator_feed(
    _: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> dict:
    try:
        return await simulator_feed()
    except SimFeedError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/hazards/auto-run")
async def read_hazard_auto_run(
    _: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> dict:
    return copy.deepcopy(auto_run)


@app.post("/api/v1/hazards/auto-run/start")
async def start_hazard_auto_run(
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    # Resuming picks up anything the Event Simulator sent while the agent was paused.
    auto_run.update({
        "running": True,
        "scans": 0,
        "startedAt": now(),
        "stoppedAt": None,
        "lastEventAt": None,
        "lastError": None,
    })
    return copy.deepcopy(auto_run)


@app.post("/api/v1/hazards/auto-run/stop")
async def stop_hazard_auto_run(
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    auto_run["running"] = False
    auto_run["stoppedAt"] = now()
    return copy.deepcopy(auto_run)


@app.post("/api/v1/simulator/hazard-inputs")
async def set_hazard_sim_input(body: HazardSimulationIn) -> dict:
    """Public: the simulation website pushes rainfall/flood-risk/reservoir values here for Agent 1 to use."""
    entry = {**body.model_dump(), "updatedAt": now()}
    S["hazardSimInputs"][body.cityId] = entry
    audit("hazard.simulation.set", entry)
    record_event(SIMULATION_INPUT_EVENT, entry)
    await persist()
    return entry


@app.delete("/api/v1/simulator/hazard-inputs/{city_id}")
async def clear_hazard_sim_input(city_id: str) -> dict:
    """Public: reverts a city to the live weather feed for Agent 1 instead of a simulated input."""
    removed = S["hazardSimInputs"].pop(city_id, None)
    if removed is None:
        raise HTTPException(404, detail="No simulated input set for this city.")
    audit("hazard.simulation.cleared", {"cityId": city_id})
    agent_seen_sources.pop(f"input:{city_id}", None)
    await persist()
    return {"cityId": city_id}


@app.post("/api/v1/hazards/scan")
async def hazard_scan(
    body: HazardScanIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    """Agent 1: scans the current weather/dam signals for the city and raises an alert if risky."""
    sim = S["hazardSimInputs"].get(body.cityId)
    if sim:
        body = body.model_copy(update={
            "rain24Mm": sim["rain24Mm"],
            "floodRiskPct": sim["floodRiskPct"],
            "reservoirFillPct": sim["reservoirFillPct"],
        })
    existing = next(
        (
            item for item in S["hazardAlerts"]
            if item["cityId"] == body.cityId and item["status"] not in ("resolved", "ignored")
            and item.get("approvalStatus") != "rejected"
            and not item.get("demoSeed")  # synthetic dashboard demo alerts never block a real scan
        ),
        None,
    )
    if existing is not None:
        refresh_alert_signal(existing, body.rain24Mm, body.floodRiskPct, body.reservoirFillPct)
        await persist()
        return {**existing, "status": "existing"}
    rule_severity = hazard_severity(body)
    rule_reasons = hazard_reasons(body, rule_severity) if rule_severity else []
    severity, reasons, llm_assisted, confidence, flood_window_hours, recommended_actions = (
        await apply_copilot_hazard_scan_judgement(body, rule_severity, rule_reasons)
    )
    outlook = record_outlook(
        S, city_id=body.cityId, place=body.place, rain_mm=body.rain24Mm, rain_window_hours=24,
        reservoir_pct=body.reservoirFillPct, flood_risk_pct=body.floodRiskPct,
    )
    if severity is None:
        await persist()
        return {"status": "calm", "severity": "low", "place": body.place, "outlook": outlook}
    alert = {
        "id": str(uuid4()),
        "cityId": body.cityId,
        "place": body.place,
        "latitude": body.latitude,
        "longitude": body.longitude,
        "rain24Mm": body.rain24Mm,
        "floodRiskPct": body.floodRiskPct,
        "landslideRiskPct": body.landslideRiskPct,
        "reservoirFillPct": body.reservoirFillPct,
        "severity": severity,
        "reasons": reasons,
        "llmAssisted": llm_assisted,
        "confidencePct": round(confidence * 100),
        "floodWindowHours": flood_window_hours,
        "recommendedActions": recommended_actions,
        "approvalStatus": "awaiting_approval" if recommended_actions else None,
        "tier": tier_from_severity(severity, confidence),
        "hazardType": hazard_type_for(body.rain24Mm, body.reservoirFillPct, body.landslideRiskPct),
        "area": body.place,
        "title": "",
        "summary": reasons[0] if reasons else "",
        "rainMm": body.rain24Mm,
        "rainWindowHours": 24,
        "rainSource": "Simulator" if sim else "Weather feed",
        "reservoirSource": "Simulator" if sim else "Sensor",
        "floodPeak": "",
        "revision": 1,
        "decisionLog": [],
        "approvedAt": None,
        "planApprovedAt": None,
        "responsePlan": [],
        "status": "pending",
        "createdAt": now(),
        "consolidated": None,
        "volunteersNeeded": None,
        "volunteerRounds": 0,
        "resolvedAt": None,
        "simulated": sim is not None,
    }
    S["hazardAlerts"].append(alert)
    audit("hazard.alert.created", {"hazardAlertId": alert["id"], "severity": severity, "tier": alert["tier"], "place": body.place})
    record_event("hazard.alert.created.v1", {"hazardAlertId": alert["id"], "severity": severity, "place": body.place})
    await persist()
    return {"status": "alert", **alert}


@app.post("/api/v1/hazards/{hazard_id}/ignore")
async def hazard_ignore(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    if alert["status"] not in ("pending", "analysed"):
        raise HTTPException(409, detail="This hazard alert can no longer be ignored.")
    alert["status"] = "ignored"
    audit("hazard.alert.ignored", {"hazardAlertId": hazard_id})
    record_event("hazard.alert.ignored.v1", {"hazardAlertId": hazard_id})
    await persist()
    return alert


@app.post("/api/v1/hazards/{hazard_id}/approve")
async def hazard_approve(
    hazard_id: str,
    body: HazardAlertActionIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    """Agent Intelligence panel: approve Agent 1's recommended actions and start the Hazard Response Agent's plan."""
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "awaiting_approval":
        raise HTTPException(409, detail="This hazard alert is not awaiting approval.")
    if body.actions:
        alert["recommendedActions"] = body.actions
    if body.actions:
        alert["revision"] = alert.get("revision", 1) + 1
    alert["approvalStatus"] = "approved"
    alert["approvedAt"] = now()
    log_decision(alert, "approve", principal.subject, alert["approvedAt"])
    alert["responsePlan"] = [
        {
            "id": str(uuid4()),
            "label": action.get("label", ""),
            "detail": action.get("detail", ""),
            "status": "awaiting_approval",
            "progress": "",
        }
        for action in alert["recommendedActions"]
    ]
    await snapshot_response_audience(alert)
    audit("hazard.alert.approved", {"hazardAlertId": hazard_id, "steps": len(alert["responsePlan"])})
    record_event("hazard.alert.approved.v1", {"hazardAlertId": hazard_id})
    await dispatch_hazard_alert(alert)
    await persist()
    return alert


async def refer_to_response(source: dict, source_kind: str, principal: Principal) -> dict:
    if not source.get("owner") or source.get("consentWithdrawnAt"):
        raise HTTPException(409, detail="An active, consented citizen request is required.")
    if source_kind == "report" and source.get("status") in ("resolved", "dismissed", "consent_withdrawn"):
        raise HTTPException(409, detail="This report is closed.")
    if source_kind == "checkin" and source.get("status") not in ("at_risk", "need_help"):
        raise HTTPException(409, detail="Only an at-risk or need-help check-in can be sent to Response.")
    field = "sourceReportIds" if source_kind == "report" else "sourceCheckinIds"
    existing = next((item for item in S["hazardAlerts"] if source["id"] in item.get(field, [])
                     and item.get("approvalStatus") == "approved"), None)
    if existing:
        return existing
    place = source.get("landmark") or live_agent.CITIZEN_ALERT_PLACE
    summary = source.get("description") or "Citizen reported risk and needs a response."
    alert = {
        "id": str(uuid4()), "cityId": f"citizen-{source_kind}-{source['id']}",
        "place": place, "area": place, "title": summary, "summary": summary,
        "latitude": source.get("latitude"), "longitude": source.get("longitude"),
        "severity": "medium", "tier": "moderate", "confidencePct": 80,
        "hazardType": "citizen", "reasons": [summary], "status": "analysed",
        "approvalStatus": "awaiting_approval", "responsePlan": [],
        "recommendedActions": [
            {"label": "Contact the citizen and assess assistance needs", "detail": place, "icon": "team"},
            {"label": "Coordinate shelter, rescue or boat assistance as requested", "detail": summary, "icon": "shelter"},
        ],
        "sourceReportIds": [source["id"]] if source_kind == "report" else [],
        "sourceCheckinIds": [source["id"]] if source_kind == "checkin" else [],
        "rain24Mm": 0, "rainMm": 0, "floodRiskPct": 0, "landslideRiskPct": 0,
        "reservoirFillPct": 0, "revision": 1, "decisionLog": [], "createdAt": now(),
        "volunteerRounds": 0, "resolvedAt": None, "simulated": True,
    }
    S["hazardAlerts"].append(alert)
    audit("citizen.response.referred", {"sourceId": source["id"], "kind": source_kind, "by": principal.subject})
    return await hazard_approve(alert["id"], HazardAlertActionIn(), f"referral:{source['id']}", principal)


@app.post("/api/v1/reports/{report_id}/response")
async def report_to_response(
    report_id: str,
    principal: Principal = Depends(require_roles("incident-commander")),
) -> dict:
    report = next((item for item in S["reports"] if item["id"] == report_id), None)
    if report is None:
        raise HTTPException(404, detail="Report not found.")
    return await refer_to_response(report, "report", principal)


@app.post("/api/v1/people/{person_id}/response")
async def checkin_to_response(
    person_id: str,
    principal: Principal = Depends(require_roles("incident-commander")),
) -> dict:
    items = _person_checkins(person_id)
    if not items:
        raise HTTPException(404, detail="No check-ins found for this person.")
    return await refer_to_response(items[-1], "checkin", principal)


async def count_registered_users() -> int:
    """Every registered citizen and volunteer account (staff excluded). Location is not considered."""
    try:
        async with sessions() as session:
            rows = await session.scalars(select(UserAccount.role))
            return sum(1 for role in rows if role != "staff")
    except SQLAlchemyError:
        logger.exception("Could not count registered users for the dispatch summary.")
        return 0


async def dispatch_hazard_alert(alert: dict) -> None:
    """Command Center dispatch (dashboard 'Approve & send'): publish the alert to every registered user
    and ask registered volunteers and verified profiles to join the simulation. No location filtering."""
    if alert.get("volunteersNeeded") is None:
        alert["volunteersNeeded"] = HAZARD_VOLUNTEERS_NEEDED.get(alert.get("severity") or "medium", 5)
    notice = live_agent.citizen_notice(alert)
    scoped = "sourceReportIds" in alert or "sourceCheckinIds" in alert
    users = len(alert.get("recipientSubjects", [])) if scoped else await count_registered_users()
    alert["citizenNotice"] = {**notice, "publishedAt": now(), "recipients": users}
    alert["dispatchedAt"] = now()
    delivery = {
        "id": str(uuid4()),
        "planId": f"hazard:{alert['id']}",
        "hazardAlertId": alert["id"],
        "revision": alert.get("revision", 1),
        "status": "simulated_delivered",
        "channels": ["app", "SMS", "WhatsApp", "push"],
        "audience": "notified citizens" if scoped else "all registered users",
        "recipients": users,
        "time": alert["dispatchedAt"],
    }
    S["deliveries"].append(delivery)
    record_event("message.approved.v1", delivery)
    already_asked = {item["subject"] for item in S["volunteerRequests"] if item["hazardAlertId"] == alert["id"]}
    picked = await hazard_volunteers(already_asked)
    if picked:
        dispatch_round(alert, picked)
    else:
        alert["status"] = "dispatched"
    audit("hazard.alert.dispatched", {
        "hazardAlertId": alert["id"], "users": users, "volunteers": len(picked),
    })


@app.post("/api/v1/hazards/{hazard_id}/reject")
async def hazard_reject(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "awaiting_approval":
        raise HTTPException(409, detail="This hazard alert is not awaiting approval.")
    alert["approvalStatus"] = "rejected"
    log_decision(alert, "reject", principal.subject, now())
    audit("hazard.alert.rejected", {"hazardAlertId": hazard_id})
    record_event("hazard.alert.rejected.v1", {"hazardAlertId": hazard_id})
    await persist()
    return alert


@app.post("/api/v1/hazards/{hazard_id}/escalate")
async def hazard_escalate(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "awaiting_approval":
        raise HTTPException(409, detail="This hazard alert is not awaiting approval.")
    alert["approvalStatus"] = "escalated"
    log_decision(alert, "escalate", principal.subject, now())
    audit("hazard.alert.escalated", {"hazardAlertId": hazard_id})
    record_event("hazard.alert.escalated.v1", {"hazardAlertId": hazard_id})
    await persist()
    return alert


@app.post("/api/v1/hazards/{hazard_id}/plan/{step_id}/approve")
async def hazard_plan_step_approve(
    hazard_id: str,
    step_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    """Send a reviewed step to the field; retained for individual retries."""
    alert = find_hazard_alert(hazard_id)
    steps = alert.get("responsePlan") or []
    step = next((item for item in steps if item["id"] == step_id), None)
    if step is None or step["status"] != "awaiting_approval":
        raise HTTPException(409, detail="This response step is not awaiting approval.")
    if alert.get("approvalStatus") != "approved":
        raise HTTPException(409, detail="Approve the hazard alert before sending its response steps.")
    volunteers = await response_volunteers(alert)
    if "recipientSubjects" not in alert:
        await snapshot_response_audience(alert)
    require_response_recipients(alert)
    create_response_task(alert, step, volunteers)
    step_index = steps.index(step)
    if step_index + 1 < len(steps) and steps[step_index + 1]["status"] == "pending":
        steps[step_index + 1]["status"] = "awaiting_approval"
    await persist()
    return alert


async def response_volunteers(alert: dict) -> list[dict]:
    accepted_subjects = {
        request["subject"] for request in S["volunteerRequests"]
        if request["hazardAlertId"] == alert["id"] and request["status"] == "accepted"
    }
    volunteers = [
        profile for profile in await hazard_volunteers(set())
        if profile["subject"] in accepted_subjects and profile["available"]
    ]
    if not volunteers:
        raise HTTPException(
            409, detail="No volunteers have accepted this hazard alert yet. "
            "Sign in to the mobile app with a registered volunteer account and choose 'Yes, I am available' on this alert.",
        )
    return volunteers


async def snapshot_response_audience(alert: dict) -> None:
    existing_tasks = [item for item in S["tasks"] if item.get("hazardAlertId") == alert["id"]]
    if existing_tasks:
        alert.update(
            recipientSubjects=sorted({subject for item in existing_tasks for subject in item.get("recipientSubjects", [])}),
            recipientScope=existing_tasks[0].get("recipientScope", "help_requests"),
            reportIds=sorted({source_id for item in existing_tasks for source_id in item.get("reportIds", [])}),
            checkinIds=sorted({source_id for item in existing_tasks for source_id in item.get("checkinIds", [])}),
        )
        return
    reports = [
        item for item in S["reports"]
        if item.get("owner") and item.get("status") not in ("resolved", "dismissed", "consent_withdrawn")
        and not item.get("consentWithdrawnAt")
        and ("sourceReportIds" not in alert or item["id"] in alert["sourceReportIds"])
    ]
    checkins = [
        item for item in live_agent.latest_checkins_by_person(S["checkins"])
        if item.get("owner") and item["status"] in ("need_help", "at_risk") and not item.get("consentWithdrawnAt")
        and ("sourceCheckinIds" not in alert or item["id"] in alert["sourceCheckinIds"])
    ]
    recipients = sorted({item["owner"] for item in reports + checkins})
    recipient_scope = "help_requests"
    if not recipients and "sourceReportIds" not in alert and "sourceCheckinIds" not in alert:
        async with sessions() as session:
            recipients = sorted((await session.scalars(
                select(UserAccount.id).where(UserAccount.role == "citizen")
            )).all())
        recipient_scope = "registered_demo_citizens"
    alert.update(
        recipientSubjects=recipients, recipientScope=recipient_scope,
        reportIds=[item["id"] for item in reports], checkinIds=[item["id"] for item in checkins],
    )


def require_response_recipients(alert: dict) -> None:
    safe = {item["subject"] for item in alert.get("responseChoices", []) if item["need"] == "safe"}
    if not set(alert.get("recipientSubjects", [])) - safe:
        raise HTTPException(409, detail="Register a demo citizen account so task updates and safety acknowledgements have a recipient.")


def create_response_task(alert: dict, step: dict, volunteers: list[dict]) -> None:
    safe = {item["subject"] for item in alert.get("responseChoices", []) if item["need"] == "safe"}
    recipients = [subject for subject in alert["recipientSubjects"] if subject not in safe]
    task = {
        "id": str(uuid4()),
        "hazardAlertId": alert["id"],
        "stepId": step["id"],
        "simulated": True,
        "summary": step["label"],
        "detail": step.get("detail") or "",
        "place": alert.get("area") or alert["place"],
        "status": "offered",
        "assignee": None,
        "offeredTo": [profile["subject"] for profile in volunteers],
        "recipientSubjects": recipients,
        "recipientScope": alert["recipientScope"],
        "reportIds": alert["reportIds"],
        "checkinIds": alert["checkinIds"],
        "declinedBy": [],
        "confirmedBy": [],
        "safetyAcknowledgements": [],
        "confirmationCount": 0,
        "confirmationTotal": len(recipients),
        "peopleAssisted": 0,
        "resources": [],
        "history": [{"status": "offered", "time": now()}],
    }
    S["tasks"].append(task)
    step["taskId"] = task["id"]
    step.pop("volunteerId", None)
    step.pop("volunteerName", None)
    step["status"] = "awaiting_volunteer"
    step["progress"] = "Waiting for a volunteer to accept the simulated task."
    if not alert.get("planApprovedAt"):
        alert["planApprovedAt"] = now()
    audit("hazard.plan.step_approved", {"hazardAlertId": alert["id"], "stepId": step["id"]})
    record_event("hazard.plan.step_approved.v1", {"hazardAlertId": alert["id"], "stepId": step["id"]})


@app.post("/api/v1/hazards/{hazard_id}/plan/dispatch")
async def hazard_plan_dispatch(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "approved" or alert.get("responseCompletedAt"):
        raise HTTPException(409, detail="This response is not open for dispatch.")
    steps = [item for item in alert.get("responsePlan", []) if item["status"] in ("pending", "awaiting_approval")]
    if not steps:
        raise HTTPException(409, detail="No response tasks are awaiting dispatch.")
    volunteers = await response_volunteers(alert)
    if "recipientSubjects" not in alert:
        await snapshot_response_audience(alert)
    require_response_recipients(alert)
    for step in steps:
        create_response_task(alert, step, volunteers)
    audit("hazard.plan.dispatched", {"hazardAlertId": hazard_id, "tasks": len(steps)})
    await persist()
    return alert


@app.post("/api/v1/hazards/{hazard_id}/plan/{step_id}/complete")
async def hazard_plan_step_complete(
    hazard_id: str,
    step_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    steps = alert.get("responsePlan") or []
    step = next((item for item in steps if item["id"] == step_id), None)
    if step is None or step["status"] != "in_field":
        raise HTTPException(409, detail="This response step is not in the field.")
    if step.get("taskId"):
        raise HTTPException(409, detail="The volunteer must submit a photo or voice note and all notified citizens must acknowledge they are safe.")
    step["status"] = "completed"
    audit("hazard.plan.step_completed", {"hazardAlertId": hazard_id, "stepId": step_id})
    record_event("hazard.plan.step_completed.v1", {"hazardAlertId": hazard_id, "stepId": step_id})
    await persist()
    return alert


def public_field_task(task: dict) -> dict:
    if not task.get("hazardAlertId"):
        return task
    view = {
        key: value for key, value in task.items()
        if key not in {"offeredTo", "recipientSubjects", "declinedBy", "confirmedBy", "assignee",
                       "safetyAcknowledgements"}
    }
    alert = find_hazard_alert(task["hazardAlertId"])
    view["assistanceNeeds"] = [
        {"need": need, "count": sum(1 for item in alert.get("responseChoices", []) if item["need"] == need)}
        for need in sorted({item["need"] for item in alert.get("responseChoices", []) if item["need"] != "safe"})
    ]
    return view


@app.get("/api/v1/my/response-updates")
def my_response_updates(principal: Principal = Depends(verify_token)) -> list[dict]:
    updates = []
    represented = set()
    for task in reversed(S["tasks"]):
        if not task.get("hazardAlertId"):
            continue
        citizen = principal.subject in task.get("recipientSubjects", [])
        volunteer = task.get("assignee") == principal.subject or (
            task["status"] == "offered" and principal.subject in task.get("offeredTo", [])
            and principal.subject not in task.get("declinedBy", [])
        )
        if not citizen and not volunteer:
            continue
        alert = find_hazard_alert(task["hazardAlertId"])
        choice = next((item["need"] for item in alert.get("responseChoices", [])
                       if item["subject"] == principal.subject), None)
        represented.add(alert["id"])
        updates.append({
            **public_field_task(task),
            "canConfirm": citizen and task["status"] == "awaiting_confirmation"
            and principal.subject not in task.get("confirmedBy", []),
            "confirmed": principal.subject in task.get("confirmedBy", []),
            "audience": "citizen" if citizen else "volunteer",
            "canRespond": citizen and choice != "safe" and not alert.get("responseCompletedAt"),
            "requestedHelp": choice,
        })
    for alert in reversed(S["hazardAlerts"]):
        if alert["id"] in represented or alert.get("approvalStatus") != "approved":
            continue
        if principal.subject not in alert.get("recipientSubjects", []):
            continue
        choice = next((item["need"] for item in alert.get("responseChoices", [])
                       if item["subject"] == principal.subject), None)
        updates.append({
            "id": f"response:{alert['id']}", "hazardAlertId": alert["id"],
            "summary": alert.get("title") or alert.get("summary") or alert["place"],
            "place": alert.get("area") or alert["place"], "detail": "",
            "status": "completed" if choice == "safe" else "ready",
            "audience": "citizen", "canRespond": choice != "safe" and not alert.get("responseCompletedAt"),
            "requestedHelp": choice, "confirmed": choice == "safe", "canConfirm": False,
        })
    return updates


@app.post("/api/v1/hazards/{hazard_id}/response")
async def choose_response(
    hazard_id: str,
    body: ResponseChoiceIn,
    principal: Principal = Depends(require_roles("resident-reporter")),
) -> dict:
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "approved":
        raise HTTPException(409, detail="This response has not been approved.")
    if "recipientSubjects" not in alert:
        await snapshot_response_audience(alert)
    if principal.subject not in alert.get("recipientSubjects", []):
        raise HTTPException(403, detail="Only a notified citizen can update this response.")
    choices = alert.setdefault("responseChoices", [])
    previous = next((item for item in choices if item["subject"] == principal.subject), None)
    if previous and previous["need"] == "safe":
        if body.need == "safe":
            return {"need": "safe"}
        raise HTTPException(409, detail="This request is closed. Submit a new risk report or check-in.")
    if alert.get("responseCompletedAt"):
        raise HTTPException(409, detail="This response is closed.")
    if previous:
        previous.update(need=body.need, at=now())
    else:
        choices.append({"subject": principal.subject, "need": body.need, "at": now()})
    if body.need == "safe":
        close_citizen_response(alert, principal.subject)
    audit("hazard.response.choice", {"hazardAlertId": hazard_id, "need": body.need, "by": principal.subject})
    record_event("hazard.response.choice.v1", {"hazardAlertId": hazard_id, "need": body.need})
    await persist()
    return {"need": body.need}


def close_citizen_response(alert: dict, subject: str) -> None:
    acknowledged_at = now()
    for report in S["reports"]:
        if (report["id"] in alert.get("reportIds", []) and report.get("owner") == subject
                and not report.get("consentWithdrawnAt")):
            report.update(status="resolved", safetyAcknowledgedAt=acknowledged_at)
    for checkin in live_agent.latest_checkins_by_person(S["checkins"]):
        if (checkin["id"] in alert.get("checkinIds", []) and checkin.get("owner") == subject
                and not checkin.get("consentWithdrawnAt")):
            checkin.update(status="safe", safetyAcknowledgedAt=acknowledged_at)
    resolved = {item["id"] for item in S["reports"] if item["status"] == "resolved"}
    for incident in S["incidents"]:
        ids = set(incident.get("reportIds", []))
        if ids & set(alert.get("reportIds", [])) and ids.issubset(resolved):
            incident["status"] = "resolved"
            record_event("incident.updated.v1", incident)
    for task in S["tasks"]:
        if task.get("hazardAlertId") != alert["id"] or subject not in task.get("recipientSubjects", []):
            continue
        if subject not in task["confirmedBy"]:
            task["confirmedBy"].append(subject)
            task.setdefault("safetyAcknowledgements", []).append({"subject": subject, "safe": True, "at": acknowledged_at})
            task["history"].append({"status": "citizen_safe", "time": acknowledged_at})
        task["confirmationCount"] = len(task["confirmedBy"])
        step = next(item for item in alert["responsePlan"] if item["id"] == task["stepId"])
        if task["confirmationCount"] == task["confirmationTotal"]:
            task.update(status="completed", completedAt=acknowledged_at)
            if step.get("taskId") == task["id"]:
                step.update(status="completed", progress="All notified citizens acknowledged safe; request closed.")
    safe = {item["subject"] for item in alert.get("responseChoices", []) if item["need"] == "safe"}
    if set(alert["recipientSubjects"]).issubset(safe):
        for step in alert.get("responsePlan", []):
            step.update(status="completed", progress="All notified citizens acknowledged safe; request closed.")
        alert["responseCompletedAt"] = acknowledged_at


@app.post("/api/v1/tasks/{task_id}/confirm")
async def confirm_hazard_task(
    task_id: str,
    principal: Principal = Depends(require_roles("resident-reporter")),
) -> dict:
    task = next((item for item in S["tasks"] if item["id"] == task_id and item.get("hazardAlertId")), None)
    if task is None:
        raise HTTPException(404, detail="Simulated response task not found.")
    if principal.subject not in task["recipientSubjects"]:
        raise HTTPException(403, detail="Only a notified citizen can confirm this task.")
    if principal.subject in task["confirmedBy"]:
        return public_field_task(task)
    if task["status"] != "awaiting_confirmation":
        raise HTTPException(409, detail="The volunteer has not submitted completion evidence yet.")
    task["confirmedBy"].append(principal.subject)
    task["confirmationCount"] = len(task["confirmedBy"])
    acknowledged_at = now()
    task.setdefault("safetyAcknowledgements", []).append({
        "subject": principal.subject, "safe": True, "at": acknowledged_at,
    })
    for checkin in live_agent.latest_checkins_by_person(S["checkins"]):
        if (
            checkin["id"] in task.get("checkinIds", []) and checkin.get("owner") == principal.subject
            and checkin["status"] == "need_help" and not checkin.get("consentWithdrawnAt")
        ):
            checkin.update(status="safe", safetyAcknowledgedAt=acknowledged_at)
    task["history"].append({"status": "citizen_safe", "time": acknowledged_at})
    alert = find_hazard_alert(task["hazardAlertId"])
    step = next(item for item in alert["responsePlan"] if item["id"] == task["stepId"])
    step["progress"] = (
        f"Completed by {task['volunteerName']}; citizens acknowledged safe: "
        f"{task['confirmationCount']}/{task['confirmationTotal']}."
    )
    if task["confirmationCount"] == task["confirmationTotal"]:
        task["status"] = "completed"
        task["completedAt"] = now()
        task["history"].append({"status": "completed", "time": task["completedAt"]})
        step.update(status="completed", progress=f"Done by {task['volunteerName']}; all notified citizens acknowledged safe.")
        if all(item["status"] == "completed" for item in alert["responsePlan"]):
            alert["responseCompletedAt"] = now()
            report_ids = {
                report_id for item in S["tasks"] if item.get("hazardAlertId") == alert["id"]
                for report_id in item.get("reportIds", [])
            }
            for report in S["reports"]:
                if report["id"] in report_ids and not report.get("consentWithdrawnAt"):
                    report["status"] = "resolved"
            resolved_report_ids = {
                report["id"] for report in S["reports"] if report["status"] == "resolved"
            }
            for incident in S["incidents"]:
                supporting_reports = set(incident.get("reportIds", []))
                if supporting_reports & report_ids and supporting_reports.issubset(resolved_report_ids):
                    incident["status"] = "resolved"
                    record_event("incident.updated.v1", incident)
    audit("hazard.task.confirmed", {"taskId": task_id, "confirmationCount": task["confirmationCount"]})
    record_event("hazard.task.confirmed.v1", {"taskId": task_id, "status": task["status"]})
    await persist()
    return public_field_task(task)


async def transition_hazard_task(task: dict, body: TaskTransitionIn, principal: Principal) -> dict:
    if task.get("assignee") not in (None, principal.subject):
        raise HTTPException(403, detail="This task is assigned to another volunteer.")
    if task.get("assignee") is None and principal.subject not in task["offeredTo"]:
        raise HTTPException(403, detail="This task was not offered to you.")
    if principal.subject in task["declinedBy"]:
        raise HTTPException(409, detail="You already declined this task.")
    transitions = {
        "offered": {"accepted", "declined"},
        "accepted": {"on_site", "blocked"},
        "on_site": {"blocked", "completed"},
    }
    if body.status not in transitions.get(task["status"], set()):
        raise HTTPException(409, detail=f"Cannot transition task from {task['status']} to {body.status}.")
    if body.status == "accepted":
        candidate = next(
            (item for item in await hazard_volunteers(set()) if item["subject"] == principal.subject), None,
        )
        accepted_alert = any(
            request["subject"] == principal.subject and request["hazardAlertId"] == task["hazardAlertId"]
            and request["status"] == "accepted" for request in S["volunteerRequests"]
        )
        if candidate is None or not candidate["available"] or not accepted_alert:
            raise HTTPException(403, detail="Only an eligible volunteer who accepted this hazard alert can accept its simulated task.")
    if body.status == "completed" and not (body.completionPhoto or body.completionVoice):
        raise HTTPException(422, detail="Upload a completion photo or voice note before requesting a citizen safety acknowledgement.")
    alert = find_hazard_alert(task["hazardAlertId"])
    step = next(item for item in alert["responsePlan"] if item["id"] == task["stepId"])
    if body.status == "declined":
        task["declinedBy"].append(principal.subject)
        if set(task["offeredTo"]).issubset(task["declinedBy"]):
            task["status"] = "declined"
            step.update(status="awaiting_approval", progress="All volunteers declined. Send again after checking availability.")
    else:
        task["status"] = "awaiting_confirmation" if body.status == "completed" else body.status
        if body.status == "accepted":
            task.update(assignee=principal.subject, volunteerId=candidate["id"], volunteerName=candidate["displayName"])
            step.update(status="in_field", volunteerId=candidate["id"], volunteerName=candidate["displayName"])
        if body.status == "completed":
            task["completionPhoto"] = body.completionPhoto
            task["completionVoice"] = body.completionVoice
            task["completionNote"] = body.note
            task["peopleAssisted"] = body.peopleAssisted or 0
            step.update(status="awaiting_confirmation", progress=f"Completed by {task['volunteerName']}; waiting for citizen confirmation.")
        elif body.status == "blocked":
            step.update(status="awaiting_approval", progress=f"Task blocked: {body.note or 'Volunteer reported a blocker'}. Send again after review.")
        else:
            step["progress"] = f"In progress by {task['volunteerName']}."
    task["updatedAt"] = now()
    task["history"].append({"status": body.status, "time": task["updatedAt"], "note": body.note})
    audit("hazard.task.transition", {"taskId": task["id"], "status": task["status"]})
    record_event("hazard.task.transition.v1", {"taskId": task["id"], "status": task["status"]})
    await persist()
    return public_field_task(task)


@app.post("/api/v1/hazards/{hazard_id}/analyse")
async def hazard_analyse(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    """Agent 2: consolidates every open citizen report and check-in (location is never used to filter)."""
    alert = find_hazard_alert(hazard_id)
    if alert["status"] != "pending":
        raise HTTPException(409, detail="This hazard alert was already analysed, ignored, or resolved.")
    scope = "all"
    matching_incidents = [item for item in S["incidents"] if item["status"] not in ("resolved", "dismissed")]
    matching_checkins = live_agent.latest_checkins_by_person(S["checkins"])
    need_help = sum(1 for item in matching_checkins if item["status"] == "need_help")
    rule_severity = alert["severity"]
    if need_help >= 5:
        rule_severity = "high"
    rule_needed = HAZARD_VOLUNTEERS_NEEDED[rule_severity]
    total_incidents = len(matching_incidents)
    approved_incidents = sum(1 for item in matching_incidents if item["status"] in ("verified", "resolved"))
    pending_review_incidents = sum(
        1 for item in matching_incidents if item["status"] in ("needs_review", "field_check_requested")
    )
    people_reported = sum(item.get("reportedPeople", 0) for item in matching_incidents)
    checkins_at_risk = sum(1 for item in matching_checkins if item["status"] == "at_risk")
    checkins_safe = sum(1 for item in matching_checkins if item["status"] == "safe")
    severity, needed, llm_reasons, llm_assisted = await apply_copilot_hazard_analyse_judgement(
        place=alert["place"],
        scope=scope,
        rule_severity=rule_severity,
        total_incidents=total_incidents,
        approved_incidents=approved_incidents,
        pending_review_incidents=pending_review_incidents,
        people_reported=people_reported,
        checkins_need_help=need_help,
        checkins_at_risk=checkins_at_risk,
        checkins_safe=checkins_safe,
        rule_volunteers_needed=rule_needed,
    )
    alert["severity"] = severity
    if llm_assisted:
        alert["reasons"] = llm_reasons
        alert["llmAssisted"] = True
    alert["consolidated"] = {
        "scope": scope,
        "totalIncidents": total_incidents,
        "approvedIncidents": approved_incidents,
        "pendingReviewIncidents": pending_review_incidents,
        "peopleReported": people_reported,
        "checkinsNeedHelp": need_help,
        "checkinsAtRisk": checkins_at_risk,
        "checkinsSafe": checkins_safe,
        "analysedAt": now(),
    }
    alert["volunteersNeeded"] = needed
    alert["status"] = "analysed"
    audit("hazard.alert.analysed", {"hazardAlertId": hazard_id, **alert["consolidated"], "volunteersNeeded": needed})
    record_event("hazard.alert.analysed.v1", {"hazardAlertId": hazard_id, "volunteersNeeded": needed})
    await persist()
    return alert


@app.post("/api/v1/hazards/{hazard_id}/dispatch-volunteers")
async def hazard_dispatch_volunteers(
    hazard_id: str,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles(*HAZARD_ROLES)),
) -> dict:
    """Re-sends the alert to every active volunteer who hasn't been asked yet (location is not used)."""
    alert = find_hazard_alert(hazard_id)
    if alert.get("approvalStatus") != "approved":
        raise HTTPException(409, detail="Approve and dispatch this alert from the Dashboard first.")
    already_asked = {item["subject"] for item in S["volunteerRequests"] if item["hazardAlertId"] == hazard_id}
    picked = await hazard_volunteers(already_asked)
    if not picked:
        raise HTTPException(409, detail="Every active volunteer has already been asked about this alert.")
    dispatch_round(alert, picked)
    await persist()
    return alert


@app.get("/api/v1/volunteer-requests/me")
def my_volunteer_requests(
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> list[dict]:
    result = []
    for item in S["volunteerRequests"]:
        if item["subject"] != principal.subject:
            continue
        alert = next((hazard for hazard in S["hazardAlerts"] if hazard["id"] == item["hazardAlertId"]), None)
        if alert is None or alert["status"] in ("ignored", "resolved") or alert.get("responseCompletedAt"):
            continue
        result.append({
            **public_volunteer_request(item),
            "place": alert.get("area") or alert["place"],
            "severity": alert["severity"],
            "tier": alert.get("tier"),
            "title": alert.get("title") or "",
            "reasons": alert["reasons"],
            "canRespond": item["status"] in ("pending", "expired"),
        })
    return result


@app.post("/api/v1/volunteer-requests/{request_id}/respond")
async def respond_volunteer_request(
    request_id: str,
    body: VolunteerRequestRespondIn,
    _idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("volunteer", "field-team")),
) -> dict:
    item = next((request for request in S["volunteerRequests"] if request["id"] == request_id), None)
    if item is None:
        raise HTTPException(404, detail="Volunteer request not found.")
    if item["subject"] != principal.subject:
        raise HTTPException(403, detail="This request belongs to another volunteer.")
    if item["status"] not in ("pending", "expired"):
        raise HTTPException(409, detail="You already responded to this alert.")
    alert = find_hazard_alert(item["hazardAlertId"])
    if alert.get("approvalStatus") != "approved" or alert.get("responseCompletedAt"):
        raise HTTPException(409, detail="This hazard alert no longer needs volunteers.")
    profile = find_volunteer(principal.subject)
    candidates = await hazard_volunteers(set())
    if not any(candidate["subject"] == principal.subject for candidate in candidates):
        raise HTTPException(403, detail="A registered volunteer account or verified profile is required to join this simulation.")
    if body.available and profile:
        profile["available"] = True
    item["status"] = "accepted" if body.available else "declined"
    item["respondedAt"] = now()
    audit("hazard.volunteer.responded", {"requestId": request_id, "status": item["status"]})
    record_event("hazard.volunteer.responded.v1", {"requestId": request_id, "status": item["status"]})
    alert = next((hazard for hazard in S["hazardAlerts"] if hazard["id"] == item["hazardAlertId"]), None)
    if alert is not None and body.available:
        accepted = sum(
            1 for request in S["volunteerRequests"]
            if request["hazardAlertId"] == alert["id"] and request["status"] == "accepted"
        )
        if accepted >= (alert.get("volunteersNeeded") or 0) and not alert.get("volunteersFilledAt"):
            # Enough people said yes; the alert stays open on the dashboard until the response is done.
            alert["volunteersFilledAt"] = now()
    await persist()
    return public_volunteer_request(item)


async def volunteer_escalation_worker() -> None:
    """Backfill open alerts for registered accounts and newly verified profiles."""
    while True:
        await asyncio.sleep(3)
        try:
            async with state_lock:
                now_text = now()
                changed = False
                for item in S["volunteerRequests"]:
                    if item["status"] == "pending" and item["expiresAt"] <= now_text:
                        item["status"] = "expired"
                        changed = True
                for alert in S["hazardAlerts"]:
                    if (
                        alert.get("approvalStatus") != "approved" or alert["status"] in ("resolved", "ignored")
                        or alert.get("responseCompletedAt")
                    ):
                        continue
                    if not alert.get("dispatchedAt"):
                        await dispatch_hazard_alert(alert)
                        changed = True
                        continue
                    already_asked = {
                        item["subject"] for item in S["volunteerRequests"] if item["hazardAlertId"] == alert["id"]
                    }
                    picked = await hazard_volunteers(already_asked)
                    if picked:
                        dispatch_round(alert, picked)
                        changed = True
                if changed:
                    await persist()
        except HTTPException:
            logger.exception("Scheduled volunteer dispatch work could not be persisted.")
        except SQLAlchemyError:
            logger.exception("Scheduled volunteer dispatch failed.")


def citizen_alert_text(plan: dict) -> dict:
    """Citizen-facing wording; internal planning notes in the plan summary are never published."""
    if plan.get("alert"):
        return {**plan["alert"], "headline": plan["alert"]["place"]}
    forecast = next((item for item in S["forecasts"] if item["id"] == plan.get("sourceId")), None)
    if forecast:
        return {
            "place": forecast["place"],
            "language": "en",
            "headline": f"Flood advisory for {forecast['place']}",
            "message": (
                f"Heavy rain ({forecast['rainfallMm']:g} mm in 24 h) and a high river level are forecast for "
                f"{forecast['place']}. Move valuables to higher floors and follow official instructions."
            ),
        }
    return {"place": "", "language": "en", "headline": "Official advisory", "message": plan["summary"]}


@app.get("/api/v1/alerts/official")
def official_alerts(principal: Principal = Depends(verify_token)) -> list[dict]:
    """Warnings a human commander approved; visible to every signed-in user."""
    approved = [
        plan for plan in S["plans"]
        if plan["kind"] == "warning" and plan["status"] == "approved"
    ]
    items = [
        {
            "id": plan["id"],
            **citizen_alert_text(plan),
            "approvedAt": plan.get("decision", {}).get("time"),
            "approvedBy": "Incident Commander",
        }
        for plan in approved
    ]
    # Hazard alerts dispatched from the Command Center dashboard reach every registered user.
    for alert in S["hazardAlerts"]:
        notice = alert.get("citizenNotice")
        if not notice or alert.get("approvalStatus") != "approved" or alert["status"] in ("ignored", "resolved"):
            continue
        if ("sourceReportIds" in alert or "sourceCheckinIds" in alert) and principal.subject not in alert.get("recipientSubjects", []):
            continue
        items.append({
            "id": alert["id"],
            "place": notice.get("place", ""),
            "language": notice.get("language", "en"),
            "headline": notice.get("headline", ""),
            "message": notice.get("message", ""),
            "tier": alert.get("tier"),
            "approvedAt": notice.get("publishedAt"),
            "approvedBy": "Incident Commander",
        })
    items.sort(key=lambda item: item.get("approvedAt") or "", reverse=True)
    return items[:20]


@app.post("/api/v1/demo/reset")
async def reset(
    _: Principal = Depends(require_roles("platform-admin")),
) -> dict:
    S.clear()
    S.update(initial())
    if SEED_HAZARD_DEMO:
        seed_hazard_demo(S)
    agent_seen_sources.clear()
    agent_user_fingerprint.update(value=None, signals=None)
    record_event("demo.reset.v1", {})
    await persist(reset_outbox=True)
    return {"ok": True}


@app.get("/api/v1/agents/run-control")
async def read_agent_run_control(
    _: Principal = Depends(require_roles("incident-commander", "verifier", "platform-admin")),
) -> dict:
    return await get_run_control()


class RunControlIn(BaseModel):
    enabled: bool


@app.post("/api/v1/agents/run-control")
async def update_agent_run_control(
    body: RunControlIn,
    _: Principal = Depends(require_roles("platform-admin", "incident-commander")),
) -> dict:
    result = await set_run_control(body.enabled, now())
    audit("agent.run_control", result)
    record_event("agent.run_control.v1", result)
    return result


@app.post("/api/v1/agents/mode/{mode}")
async def mode(
    mode: str,
    _: Principal = Depends(require_roles("platform-admin", "incident-commander")),
) -> dict:
    if mode != "rules":
        raise HTTPException(409, detail="No AI model is configured; only deterministic rules mode is available.")
    for agent_state in S["agents"].values():
        agent_state["mode"] = mode
    audit("agent.mode", {"mode": mode})
    record_event("agent.mode.v1", {"mode": mode})
    await persist()
    return S["agents"]


class LlmSettingsIn(BaseModel):
    llmMode: Literal["copilot-sdk"] = "copilot-sdk"
    llmModel: str | None = Field(default=None, max_length=200)
    githubToken: str | None = Field(default=None, max_length=300)


class LlmModelsIn(BaseModel):
    githubToken: str | None = Field(default=None, max_length=300)


@app.get("/api/v1/agents/llm-settings")
async def read_agent_llm_settings(
    _: Principal = Depends(require_roles("platform-admin")),
) -> dict:
    return await get_llm_settings()


COPILOT_TOKEN_PREFIXES = ("gho_", "ghu_", "github_pat_")


def validate_copilot_token_format(token: str) -> None:
    if not token.startswith(COPILOT_TOKEN_PREFIXES):
        raise HTTPException(
            422,
            detail=(
                "That doesn't look like a Copilot-compatible token. The Copilot SDK accepts "
                "gho_, ghu_, or github_pat_ tokens for an account with an active Copilot "
                "subscription - classic ghp_ personal access tokens are not supported."
            ),
        )


@app.post("/api/v1/agents/llm-models")
async def list_agent_llm_models(
    body: LlmModelsIn,
    _: Principal = Depends(require_roles("platform-admin")),
) -> dict:
    """Lists the Copilot models available to a token, so the admin can pick one - nothing is hardcoded.

    Uses the token in the request body if supplied (so an admin can list models for a token they haven't
    saved yet), otherwise falls back to the already-saved token."""
    token = body.githubToken.strip() if body.githubToken else None
    if token:
        validate_copilot_token_format(token)
    else:
        token = (await get_llm_settings_with_token()).get("githubToken") or ""
        token = token.strip()
    if not token:
        raise HTTPException(422, detail="Enter a GitHub Copilot token first, then list models.")
    try:
        models = await copilot_agent.list_models(token)
    except CopilotJudgementError as exc:
        raise HTTPException(502, detail=str(exc)) from exc
    return {"models": models}


@app.post("/api/v1/agents/llm-settings")
async def update_agent_llm_settings(
    body: LlmSettingsIn,
    _: Principal = Depends(require_roles("platform-admin")),
) -> dict:
    token = body.githubToken.strip() if body.githubToken else None
    if not token and not (await get_llm_settings())["hasToken"]:
        raise HTTPException(
            422, detail="A GitHub Copilot token (gho_/ghu_/github_pat_) is required."
        )
    if token:
        validate_copilot_token_format(token)
    llm_model = (body.llmModel or "").strip()
    if not llm_model:
        raise HTTPException(
            422, detail="Choose a model (use 'List models' to see what this token's account can access)."
        )
    result = await set_llm_settings("copilot-sdk", llm_model, token, now())
    for agent_state in S["agents"].values():
        agent_state["mode"] = "copilot-sdk"
    audit("agent.llm_settings", {"llmMode": result["llmMode"], "llmModel": result["llmModel"]})
    await persist()
    return result


@app.post("/api/v1/agents/{aid}/{action}")
async def agent(
    aid: str,
    action: Literal["start", "stop", "run", "restart"],
    _: Principal = Depends(require_roles("platform-admin", "incident-commander")),
) -> dict:
    if aid not in S["agents"]:
        raise HTTPException(404, detail="Unknown agent.")
    current = S["agents"][aid]
    current["status"] = "stopped" if action == "stop" else "healthy"
    if action in {"run", "restart"}:
        current["lastRun"] = now()
    audit(f"agent.{action}", {"agent": aid})
    record_event("agent.status.v1", {"agent": aid, **current})
    await persist()
    return current


@app.post("/api/v1/simulator/forecasts")
async def simulate_forecast(
    body: ForecastIn,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles("incident-commander", "platform-admin", "source-agent", "agent-a2")),
) -> dict:
    result = await add_forecast(body, idempotency_key)
    await persist()
    return {key: value for key, value in result.items() if key not in {"key", "requestHash"}}


@app.post("/api/v1/demo/forecast")
async def demo_forecast(
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    _: Principal = Depends(require_roles("incident-commander", "platform-admin")),
) -> dict:
    result = await add_forecast(
        ForecastIn(place="Palarivattom", rainfallMm=145, riverLevelM=3.4, source="Demo feed"),
        idempotency_key,
    )
    await persist()
    return {key: value for key, value in result.items() if key not in {"key", "requestHash"}}


@app.post("/api/v1/reports")
async def report(
    body: ReportIn,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(
        require_roles("resident-reporter", "incident-commander", "verifier")
    ),
) -> dict:
    result = await add_report(body, idempotency_key, principal)
    await persist()
    return result


@app.post("/api/v1/simulator/reports")
async def source_report(
    body: SourceReportIn,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("source-agent")),
) -> dict:
    result = await add_report(body, idempotency_key, principal)
    await persist()
    return result


@app.post("/api/v1/check-ins")
async def check_in(
    body: CheckInIn,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("resident-reporter")),
) -> dict:
    if not body.consent:
        raise HTTPException(422, detail="Consent is required before submitting a check-in.")
    existing = next(
        (item for item in S["checkins"] if item["key"] == idempotency_key), None
    )
    if existing:
        if existing["requestHash"] != request_hash(body):
            raise HTTPException(409, detail="Idempotency key was already used with a different request.")
        if existing["owner"] != principal.subject:
            raise HTTPException(403, detail="This idempotency key belongs to another user.")
        return {
            key: value
            for key, value in existing.items()
            if key not in {"owner", "key", "requestHash"}
        }
    entry = {
        "id": str(uuid4()),
        "key": idempotency_key,
        "requestHash": request_hash(body),
        "owner": principal.subject,
        "status": body.status,
        "landmark": body.landmark,
        "latitude": body.latitude,
        "longitude": body.longitude,
        "accuracyM": body.accuracyM,
        "locationSource": body.locationSource,
        "time": now(),
    }
    S["checkins"].append(entry)
    S["consents"].append(
        {
            "id": str(uuid4()),
            "subject": principal.subject,
            "resourceId": entry["id"],
            "purpose": "response-coordination",
            "channel": "citizen-app",
            "grantedAt": entry["time"],
            "withdrawnAt": None,
        }
    )
    record_event("checkin.received.v1", {"status": body.status})
    audit("checkin.received", {"status": body.status})
    await persist()
    return {
        key: value for key, value in entry.items() if key not in {"owner", "key", "requestHash"}
    }


PEOPLE_ROLES = ("incident-commander", "verifier")
CHECKIN_FIELDS = ("latitude", "longitude", "accuracyM", "locationSource")


def _mask_phone(phone: str) -> str:
    return f"{phone[:2]}XXXXXX{phone[-2:]}"


def _person_checkins(person_id: str) -> list[dict]:
    return sorted(
        (item for item in S["checkins"]
         if item.get("owner") == person_id and item.get("status") != "consent_withdrawn"),
        key=lambda item: item["time"],
    )


@app.get("/api/v1/people")
async def people(_: Principal = Depends(require_roles(*PEOPLE_ROLES))) -> list[dict]:
    owners = {item["owner"] for item in S["checkins"] if item.get("owner")}
    async with sessions() as session:
        rows = await session.scalars(select(UserAccount).where(UserAccount.id.in_(owners))) if owners else []
        accounts = {row.id: row for row in rows}
    result = []
    for owner in owners:
        items = _person_checkins(owner)
        if not items:
            continue
        latest = items[-1]
        account = accounts.get(owner)
        result.append({
            "personId": owner,
            "name": account.name if account else None,
            "maskedPhone": _mask_phone(account.phone) if account else None,
            "accountType": account.role if account else None,
            "status": latest["status"],
            "landmark": latest["landmark"],
            **{key: latest.get(key) for key in CHECKIN_FIELDS},
            "lastCheckIn": latest["time"],
            "escalated": bool(latest.get("escalated")),
            "history": [
                {key: item.get(key) for key in ("id", "status", "landmark", "time", "source", "note", *CHECKIN_FIELDS)}
                for item in reversed(items)
            ],
        })
    return sorted(result, key=lambda person: person["lastCheckIn"], reverse=True)


class PersonStatusIn(BaseModel):
    status: Literal["safe", "at_risk", "need_help"]
    reason: str = Field(min_length=5, max_length=500)
    escalate: bool = False


@app.post("/api/v1/people/{person_id}/status")
async def set_person_status(
    person_id: str,
    body: PersonStatusIn,
    principal: Principal = Depends(require_roles("incident-commander")),
) -> dict:
    items = _person_checkins(person_id)
    if not items:
        raise HTTPException(404, detail="No check-ins found for this person.")
    latest = items[-1]
    entry = {
        "id": str(uuid4()),
        "key": f"staff:{uuid4()}",
        "requestHash": "",
        "owner": person_id,
        "status": body.status,
        "landmark": latest["landmark"],
        **{key: latest.get(key) for key in CHECKIN_FIELDS},
        "time": now(),
        "source": "staff",
        "note": body.reason,
        "escalated": body.escalate,
        "updatedBy": principal.subject,
    }
    S["checkins"].append(entry)
    record_event("checkin.staff_updated.v1", {"status": body.status, "escalated": body.escalate})
    audit("checkin.staff_updated", {
        "personId": person_id, "status": body.status, "escalated": body.escalate, "reason": body.reason,
        "by": principal.subject,
    })
    await persist()
    return {"status": entry["status"], "time": entry["time"]}


class ContactAccessIn(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=5, max_length=300)


# Per-staff failed attempts for the shared citizen access code: subject -> (failures, locked_until_ms).
_access_failures: dict[str, tuple[int, int]] = {}


@app.post("/api/v1/people/{person_id}/contact")
async def person_contact(
    person_id: str,
    body: ContactAccessIn,
    principal: Principal = Depends(require_roles(*PEOPLE_ROLES)),
) -> dict:
    if not _person_checkins(person_id):
        raise HTTPException(404, detail="No check-ins found for this person.")
    access_code = os.getenv("ASHRAAY_CITIZEN_ACCESS_CODE", "")
    if not access_code:
        raise HTTPException(503, detail="Citizen data access is not configured.")
    failures, locked_until = _access_failures.get(principal.subject, (0, 0))
    if locked_until > _now_ms():
        raise HTTPException(429, detail="Too many failed attempts. Try again in 15 minutes.")
    if not hmac.compare_digest(body.password.encode(), access_code.encode()):
        failures += 1
        _access_failures[principal.subject] = (
            (0, _now_ms() + LOCKOUT_SECONDS * 1000) if failures >= MAX_FAILED_LOGINS else (failures, 0)
        )
        audit("citizen_data.denied", {"personId": person_id, "reason": body.reason, "by": principal.subject})
        await persist()
        # 403, not 401: a 401 would sign the staff member out.
        raise HTTPException(403, detail="Access code is incorrect.")
    _access_failures.pop(principal.subject, None)
    async with sessions() as session:
        person = await session.get(UserAccount, person_id)
    if person is None:
        raise HTTPException(404, detail="No contact details are stored for this person.")
    audit("citizen_data.accessed", {"personId": person_id, "reason": body.reason, "by": principal.subject})
    await persist()
    return {"name": person.name, "phone": f"+91 {person.phone}", "email": person.email, "accountType": person.role}


@app.get("/api/v1/reports/{case_id}")
def report_status(case_id: str, principal: Principal = Depends(verify_token)) -> dict:
    found = next((item for item in S["reports"] if item["caseId"] == case_id), None)
    if found is None:
        raise HTTPException(404, detail="Report not found.")
    if found.get("owner") != principal.subject and not principal.has_any(
        "incident-commander", "verifier"
    ):
        raise HTTPException(403, detail="You may only view your own reports.")
    return reporter_view(found)


def correlate_report(report_item: dict) -> None:
    """Match a single 'received' report to an existing incident, or create a new one.

    Shared by the A1 batch-processing endpoint and the simplified report-decision endpoint, so a
    single report can be correlated on demand without waiting for a full A1 pass.
    """
    if report_item["status"] != "received":
        return
    matching = next(
        (
            incident
            for incident in S["incidents"]
            if incident["landmark"].casefold() == report_item["landmark"].casefold()
            and incident["status"] not in {"dismissed", "resolved"}
        ),
        None,
    )
    if matching:
        if report_item["id"] not in matching["reportIds"]:
            matching["reportIds"].append(report_item["id"])
            matching["reportedPeople"] = max(
                matching["reportedPeople"], report_item["people"]
            )
        if matching["status"] == "field_check_requested" and report_item["source"] != "social":
            matching["status"] = "needs_review"
            matching["confidence"] = max(matching["confidence"], 0.72)
            matching["confidenceBasis"] = (
                "Additional non-social report received after field-check request; verifier confirmation is still required."
            )
            review = next(
                item
                for item in S["reviews"]
                if item["incidentId"] == matching["id"]
            )
            review["status"] = "pending"
            review["reason"] = "Additional report received; verifier must resolve the requested field check."
            record_event("review.requested.v1", review)
            record_event("incident.updated.v1", matching)
        if matching["status"] == "needs_review":
            for existing_report in S["reports"]:
                if existing_report["id"] in matching["reportIds"]:
                    existing_report["status"] = "needs_review"
        report_item["status"] = matching["status"]
        report_item["incidentId"] = matching["id"]
        return
    confidence = 0.38 if report_item["source"] == "social" else 0.70
    status = "needs_review" if confidence < 0.8 else "verified"
    incident = {
        "id": str(uuid4()),
        "reportIds": [report_item["id"]],
        "description": report_item["description"],
        "summary": report_item["description"],
        "landmark": report_item["landmark"],
        "reportedPeople": report_item["people"],
        "severity": "high" if report_item["people"] > 0 else "moderate",
        "confidence": confidence,
        "checkRequired": confidence < 0.8,
        "confidenceBasis": (
            "Uncorroborated social signal; human review required."
            if report_item["source"] == "social"
            else "Deterministic backup-rules output capped at 0.70; verifier confirmation required."
        ),
        "status": status,
        "time": now(),
    }
    S["incidents"].append(incident)
    report_item["status"] = status
    report_item["incidentId"] = incident["id"]
    record_event("incident.updated.v1", incident)
    if status == "needs_review":
        review = {
            "id": str(uuid4()),
            "incidentId": incident["id"],
            "status": "pending",
            "reason": "Evidence confidence is below 0.80; verifier confirmation is required.",
        }
        S["reviews"].append(review)
        record_event("review.requested.v1", review)


@app.post("/api/v1/processing/a1")
async def a1process(
    _: Principal = Depends(require_roles("incident-commander", "source-agent", "agent-a1")),
) -> list[dict]:
    for report_item in S["reports"]:
        correlate_report(report_item)
    audit("a1.processed", {"incidents": len(S["incidents"])})
    S["agents"]["a1"].update(status="healthy", lastRun=now())
    await persist()
    return S["incidents"]


@app.post("/api/v1/reviews/{review_id}/decision")
async def review_decision(
    review_id: str,
    body: ReviewIn,
    principal: Principal = Depends(require_roles("verifier", "incident-commander")),
) -> dict:
    review = next((item for item in S["reviews"] if item["id"] == review_id), None)
    if review is None:
        raise HTTPException(404, detail="Review not found.")
    if review["status"] != "pending":
        raise HTTPException(409, detail="This review has already been resolved.")
    incident = next(item for item in S["incidents"] if item["id"] == review["incidentId"])
    if body.action != "dismiss" and not has_active_consent(incident):
        raise HTTPException(
            409,
            detail="Response-coordination consent is no longer active; dismiss the evidence or obtain fresh consent.",
        )
    review.update(
        status=body.action,
        reason=body.reason,
        actor=principal.subject,
        decidedAt=now(),
    )
    if body.action == "confirm":
        incident["status"] = "verified"
        incident["confidence"] = max(incident["confidence"], 0.65)
        incident["checkRequired"] = False
    else:
        incident["status"] = "dismissed"
    for report_item in S["reports"]:
        if (
            report_item["id"] in incident["reportIds"]
            and not report_item.get("consentWithdrawnAt")
        ):
            report_item["status"] = incident["status"]
    record_event("review.decided.v1", {"reviewId": review_id, "action": body.action})
    audit("review.decided", {"reviewId": review_id, "action": body.action})
    await persist()
    return review


@app.post("/api/v1/reports/{report_id}/decision")
async def report_decision(
    report_id: str,
    body: ReportDecisionIn,
    principal: Principal = Depends(require_roles("verifier", "incident-commander")),
) -> dict:
    """Single-step Approve/Discard for an incident report, from the Dashboard's incident list.

    Correlates the report into an incident (running the same logic as A1 processing) if that has not
    happened yet, then immediately records the decision - no separate evidence-review step required.
    """
    report = next((item for item in S["reports"] if item["id"] == report_id), None)
    if report is None:
        raise HTTPException(404, detail="Report not found.")
    if report.get("consentWithdrawnAt"):
        raise HTTPException(409, detail="Consent was withdrawn for this report.")
    correlate_report(report)
    incident = next((item for item in S["incidents"] if item["id"] == report.get("incidentId")), None)
    if incident is None:
        raise HTTPException(409, detail="This report could not be correlated into an incident yet.")
    if incident["status"] in {"verified", "dismissed"}:
        raise HTTPException(409, detail="This incident has already been reviewed.")
    if body.action == "approve" and not has_active_consent(incident):
        raise HTTPException(
            409,
            detail="Response-coordination consent is no longer active; discard the evidence or obtain fresh consent.",
        )
    new_status = "verified" if body.action == "approve" else "dismissed"
    incident["status"] = new_status
    if body.action == "approve":
        incident["confidence"] = max(incident["confidence"], 0.65)
        incident["checkRequired"] = False
    for report_item in S["reports"]:
        if report_item["id"] in incident["reportIds"] and not report_item.get("consentWithdrawnAt"):
            report_item["status"] = new_status
    for review in S["reviews"]:
        if review["incidentId"] == incident["id"] and review["status"] == "pending":
            review.update(
                status="confirm" if body.action == "approve" else "dismiss",
                reason="Reviewed via Command Center.",
                actor=principal.subject,
                decidedAt=now(),
            )
    record_event("review.decided.v1", {"incidentId": incident["id"], "action": body.action})
    audit("review.decided", {"incidentId": incident["id"], "action": body.action, "by": principal.subject})
    await persist()
    return {"incidentId": incident["id"], "status": new_status}


@app.post("/api/v1/processing/a3")
async def a3process(
    _: Principal = Depends(require_roles("incident-commander", "source-agent", "agent-a3")),
) -> list[dict]:
    expire_pending_plans()
    expire_resource_holds()
    for incident in S["incidents"]:
        if incident["status"] != "verified" or not has_active_consent(incident):
            continue
        rescue_plans = [
            plan
            for plan in S["plans"]
            if plan.get("incidentId") == incident["id"] and plan["kind"] == "rescue"
        ]
        if not rescue_plans:
            proposed = create_plan(
                "rescue",
                f"Respond to {incident['reportedPeople']} reported people near {incident['landmark']}. "
                "Confirm route and available team before dispatch.",
                incident["confidence"],
                incident_id=incident["id"],
            )
            hold_resources(proposed)
            continue
        current = max(rescue_plans, key=lambda plan: plan["revision"])
        if current["status"] in {"rejected", "expired"}:
            revised = {
                **current,
                "id": str(uuid4()),
                "revision": current["revision"] + 1,
                "status": "pending",
                "summary": (
                    f"Re-planned after the prior proposal was rejected. "
                    f"Respond to {incident['reportedPeople']} reported people near "
                    f"{incident['landmark']}; reassess route and resources."
                ),
                "createdAt": now(),
            }
            S["plans"].append(revised)
            hold_resources(revised)
            record_event("plan.proposed.v1", revised)
    audit("a3.processed", {})
    S["agents"]["a3"].update(status="healthy", lastRun=now())
    await persist()
    return S["plans"]


@app.post("/api/v1/alerts")
async def create_alert(
    body: AlertIn,
    idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=128),
    principal: Principal = Depends(require_roles("incident-commander")),
) -> dict:
    existing = next(
        (
            plan
            for plan in S["plans"]
            if plan.get("_alertIdempotency", {}).get("key") == idempotency_key
        ),
        None,
    )
    if existing:
        metadata = existing["_alertIdempotency"]
        if metadata["owner"] != principal.subject:
            raise HTTPException(403, detail="This idempotency key belongs to another user.")
        if metadata["requestHash"] != request_hash(body):
            raise HTTPException(409, detail="Idempotency key was already used with a different request.")
        return {
            key: value
            for key, value in existing.items()
            if key != "_alertIdempotency"
        }
    plan = create_plan(
        "warning",
        f"{body.place} ({body.language}): {body.message}",
        1.0,
    )
    plan["alert"] = {"place": body.place, "language": body.language, "message": body.message}
    plan["_alertIdempotency"] = {
        "key": idempotency_key,
        "requestHash": request_hash(body),
        "owner": principal.subject,
    }
    plan["createdBy"] = principal.subject
    audit("alert.drafted", {"planId": plan["planId"]})
    await persist()
    return plan


@app.post("/api/v1/plans/{plan_id}/decisions")
async def decision(
    plan_id: str,
    body: DecisionIn,
    principal: Principal = Depends(require_roles("incident-commander")),
) -> dict:
    current = latest_plan(plan_id)
    if current is None:
        raise HTTPException(404, detail="Plan not found.")
    if body.revision != current["revision"]:
        raise HTTPException(409, detail="The supplied revision is stale.")
    expired_holds = expire_resource_holds()
    expired_plans = expire_pending_plans()
    if expired_holds or expired_plans:
        await persist()
    if current["status"] != "pending":
        raise HTTPException(409, detail="Only a pending plan can be decided.")
    if body.action == "approve" and current["kind"] == "rescue":
        incident = next(
            (item for item in S["incidents"] if item["id"] == current.get("incidentId")), None,
        )
        if incident is None or not has_active_consent(incident):
            raise HTTPException(409, detail="Active supporting consent is required before rescue approval.")
    if body.action == "approve" and current["kind"] == "rescue" and current.get("unmetNeeds"):
        raise HTTPException(
            409,
            detail="Rescue resources are unavailable. Modify the plan or wait for resources before approval.",
        )
    if body.action == "approve" and current["kind"] == "rescue":
        held = [
            item for item in S["reservations"]
            if item["planId"] == plan_id
            and item["revision"] == body.revision
            and item["status"] == "held"
        ]
        if (
            sorted(item["kind"] for item in held) != ["boat", "response-team"]
            or len({item["resourceId"] for item in held}) != 2
            or any(
                not any(
                    resource["id"] == item["resourceId"] and resource["status"] == "available"
                    for resource in S["resources"]
                )
                for item in held
            )
        ):
            raise HTTPException(
                409, detail="Valid unexpired resource holds are required before rescue approval.",
            )
    if body.action == "modify" and not body.modification:
        raise HTTPException(422, detail="A complete revised plan is required for modify decisions.")
    trace_id = trace()
    if body.action == "modify":
        release_reservations(plan_id, current["revision"], "plan modified")
        current["status"] = "superseded"
        revised = {
            **current,
            "id": str(uuid4()),
            "revision": current["revision"] + 1,
            "status": "pending",
            "summary": body.modification or f"{current['summary']} (modified: {body.reason})",
            "createdAt": now(),
        }
        if revised["kind"] == "rescue":
            hold_resources(revised)
        S["plans"].append(revised)
        result = revised
    else:
        current["status"] = {
            "approve": "approved",
            "reject": "rejected",
            "escalate": "escalated",
        }[body.action]
        current["decision"] = {
            "action": body.action,
            "reason": body.reason,
            "actor": principal.subject,
            "time": now(),
            "revision": body.revision,
        }
        if body.action == "reject":
            release_reservations(plan_id, body.revision, "plan rejected")
        result = current
        if body.action == "approve" and current["kind"] == "warning":
            delivery = {
                "id": str(uuid4()),
                "planId": plan_id,
                "revision": body.revision,
                "status": "simulated_delivered",
                "channels": ["SMS", "WhatsApp", "push"],
                "time": now(),
            }
            S["deliveries"].append(delivery)
            record_event("message.approved.v1", delivery, trace_id)
        if body.action == "approve" and current["kind"] == "rescue":
            reservations = [
                reservation
                for reservation in S["reservations"]
                if reservation["planId"] == plan_id
                and reservation["revision"] == body.revision
                and reservation["status"] == "held"
            ]
            for reservation in reservations:
                reservation["status"] = "committed"
                reservation.pop("expiresAt", None)
            record_event(
                "resource.committed.v1",
                {"planId": plan_id, "revision": body.revision},
                trace_id,
            )
            task = {
                "id": str(uuid4()),
                "planId": plan_id,
                "planRevision": body.revision,
                "incidentId": current.get("incidentId"),
                "status": "offered",
                "summary": current["summary"],
                "peopleAssisted": 0,
                "resources": [item["resourceName"] for item in reservations],
                "history": [{"status": "offered", "time": now()}],
            }
            S["tasks"].append(task)
            record_event("task.approved.v1", task, trace_id)
    audit(
        f"decision.{body.action}",
        {"planId": plan_id, "revision": body.revision, "reason": body.reason},
        trace_id,
    )
    record_event(
        "decision.recorded.v1",
        {"planId": plan_id, "revision": body.revision, "action": body.action},
        trace_id,
    )
    await persist()
    return {
        key: value
        for key, value in result.items()
        if key not in {"key", "requestHash", "owner"}
    }


@app.post("/api/v1/tasks/{task_id}/transitions")
async def task_transition(
    task_id: str,
    body: TaskTransitionIn,
    principal: Principal = Depends(require_roles("volunteer", "field-team", "response-agency")),
) -> dict:
    task = next((item for item in S["tasks"] if item["id"] == task_id), None)
    if task is None:
        raise HTTPException(404, detail="Task not found.")
    if task.get("hazardAlertId"):
        return await transition_hazard_task(task, body, principal)
    if task.get("assignee") not in {None, principal.subject}:
        raise HTTPException(403, detail="This task is assigned to another responder.")
    if body.status == "accepted" and is_pure_volunteer(principal) and not volunteer_may_work(principal):
        raise HTTPException(
            403, detail="Only a verified volunteer who is marked available can accept tasks.",
        )
    transitions = {
        "offered": {"accepted", "declined"},
        "accepted": {"on_site", "blocked"},
        "on_site": {"blocked", "completed"},
        "blocked": set(),
        "declined": set(),
        "completed": set(),
    }
    if body.status not in transitions[task["status"]]:
        raise HTTPException(
            409, detail=f"Cannot transition task from {task['status']} to {body.status}."
        )
    task["status"] = body.status
    if body.status == "accepted":
        task["assignee"] = principal.subject
    task["updatedAt"] = now()
    task["updatedBy"] = principal.subject
    if body.peopleAssisted is not None:
        task["peopleAssisted"] = body.peopleAssisted
    task["history"].append(
        {"status": body.status, "time": task["updatedAt"], "note": body.note}
    )
    record_event("assignment.status.v1", task)
    if body.status in {"blocked", "declined"}:
        release_reservations(task["planId"], task["planRevision"], f"task {body.status}")
        old_plan = latest_plan(task["planId"])
        incident = next(
            (item for item in S["incidents"] if item["id"] == task.get("incidentId")), None,
        )
        if incident is None or not has_active_consent(incident):
            task["replanBlockedReason"] = "Active supporting consent is required before further planning."
            detail = {"taskId": task_id, "reason": task["replanBlockedReason"]}
            record_event("plan.replan_blocked.v1", detail)
            audit("plan.replan_blocked", detail)
        elif old_plan:
            old_plan["status"] = "superseded"
            revised = {
                **old_plan,
                "id": str(uuid4()),
                "revision": old_plan["revision"] + 1,
                "status": "pending",
                "summary": (
                    f"{old_plan['summary']} "
                    + (
                        f"Alternate route required: {body.note or 'blocked route reported'}."
                        if body.status == "blocked"
                        else "Task was declined; assign an alternate responder."
                    )
                ),
                "createdAt": now(),
            }
            S["plans"].append(revised)
            hold_resources(revised)
            record_event("plan.proposed.v1", revised)
    if body.status == "completed" and task.get("incidentId"):
        release_reservations(task["planId"], task["planRevision"], "task completed")
        incident = next(
            (item for item in S["incidents"] if item["id"] == task["incidentId"]), None
        )
        if incident:
            incident["status"] = "resolved"
            for report_item in S["reports"]:
                if report_item["id"] in incident["reportIds"]:
                    if not report_item.get("consentWithdrawnAt"):
                        report_item["status"] = "resolved"
            record_event("incident.updated.v1", incident)
    audit("task.transition", {"taskId": task_id, "status": body.status})
    await persist()
    return task


@app.post("/api/v1/tasks/{task_id}/status", include_in_schema=False)
async def legacy_task_status(
    task_id: str,
    body: TaskTransitionIn,
    principal: Principal = Depends(require_roles("volunteer", "field-team", "response-agency")),
) -> dict:
    return await task_transition(task_id, body, principal)
