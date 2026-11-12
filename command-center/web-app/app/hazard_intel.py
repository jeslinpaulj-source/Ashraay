"""Hazard Intelligence / Hazard Response helpers.

Adds the CAP-style severity tier (extreme / severe / moderate / minor) as a new field on every
hazard alert stored in the existing ``demo_state`` JSON record (``hazardAlerts``), plus the extra
fields the Command Center dashboard tiles read (hazard type, area, title, summary, evidence and
the decision log). No new tables are created.

The legacy ``severity`` field (low / medium / high) is kept unchanged because the volunteer-dispatch
flow and the Copilot judgement schema still use it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import uuid4

HazardTier = Literal["extreme", "severe", "moderate", "minor"]
TIERS: tuple[HazardTier, ...] = ("extreme", "severe", "moderate", "minor")
TIER_RANK = {tier: index for index, tier in enumerate(TIERS)}
# Legacy severity that matches each tier, for alerts created from a tier (e.g. demo seed data).
TIER_TO_SEVERITY = {"extreme": "high", "severe": "high", "moderate": "medium", "minor": "low"}
# How often Agent 1 (Hazard Intelligence Agent) is expected to re-run its forecast.
MODEL_RUN_INTERVAL_MINUTES = 30


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def tier_from_severity(severity: str | None, confidence: float | None) -> HazardTier:
    """Maps the legacy low/medium/high severity (+ confidence 0..1) to the four-level tier."""
    if severity == "high":
        return "extreme" if (confidence or 0) >= 0.8 else "severe"
    if severity == "medium":
        return "moderate"
    return "minor"


def hazard_type_for(rain_mm: float, reservoir_pct: float, landslide_pct: float) -> str:
    if landslide_pct >= 60 and landslide_pct >= reservoir_pct:
        return "landslide"
    return "flood"


def ensure_alert_fields(alert: dict[str, Any]) -> dict[str, Any]:
    """Backfills the new fields on alerts stored before they existed (idempotent)."""
    confidence = (alert.get("confidencePct") or 0) / 100
    alert.setdefault("tier", tier_from_severity(alert.get("severity"), confidence))
    alert.setdefault(
        "hazardType",
        hazard_type_for(alert.get("rain24Mm") or 0, alert.get("reservoirFillPct") or 0, alert.get("landslideRiskPct") or 0),
    )
    alert.setdefault("area", alert.get("place", ""))
    alert.setdefault("title", "")
    alert.setdefault("summary", (alert.get("reasons") or [""])[0])
    alert.setdefault("rainMm", alert.get("rain24Mm") or 0)
    alert.setdefault("rainWindowHours", 24)
    alert.setdefault("rainSource", "Weather feed")
    alert.setdefault("reservoirSource", "Sensor")
    alert.setdefault("floodPeak", "")
    alert.setdefault("revision", 1)
    alert.setdefault("decisionLog", [])
    alert.setdefault("approvedAt", None)
    alert.setdefault("planApprovedAt", None)
    return alert


def log_decision(alert: dict[str, Any], action: str, actor: str, at: str) -> None:
    alert.setdefault("decisionLog", []).append(
        {"action": action, "actor": actor, "at": at, "revision": alert.get("revision", 1)}
    )


def record_outlook(state: dict[str, Any], *, city_id: str, place: str, rain_mm: float, rain_window_hours: int,
                   reservoir_pct: float, flood_risk_pct: float, at: datetime | None = None) -> dict[str, Any]:
    """Stores Agent 1's latest readings for a city; the dashboard shows them in the 'all clear' state."""
    moment = at or datetime.now(timezone.utc)
    entry = {
        "cityId": city_id,
        "place": place,
        "rainMm": round(rain_mm, 1),
        "rainWindowHours": rain_window_hours,
        "reservoirFillPct": round(reservoir_pct),
        "floodRiskPct": round(flood_risk_pct),
        "modelRunAt": _iso(moment),
        "nextRunAt": _iso(moment + timedelta(minutes=MODEL_RUN_INTERVAL_MINUTES)),
    }
    state.setdefault("hazardOutlook", {})[city_id] = entry
    return entry


def _step(label: str, detail: str, status: str, progress: str = "") -> dict[str, Any]:
    return {"id": str(uuid4()), "label": label, "detail": detail, "status": status, "progress": progress}


def demo_hazard_alerts(now: datetime | None = None) -> list[dict[str, Any]]:
    """Synthetic Bengaluru alerts, one per tier and each at a different stage, loaded on start/reset.

    Synthetic demo data only - not an official forecast.
    """
    now = now or datetime.now(timezone.utc)
    base = {
        "cityId": "bengaluru",
        "llmAssisted": False,
        "status": "pending",
        "consolidated": None,
        "volunteersNeeded": None,
        "volunteerRounds": 0,
        "resolvedAt": None,
        "simulated": True,
        "demoSeed": True,
        "revision": 1,
        "approvedAt": None,
        "planApprovedAt": None,
    }

    def alert(**fields: Any) -> dict[str, Any]:
        item = {**base, "id": str(uuid4()), **fields}
        item["severity"] = TIER_TO_SEVERITY[item["tier"]]
        item.setdefault("decisionLog", [])
        return item

    bellandur = alert(
        tier="extreme", hazardType="flood", place="Bellandur", area="Bellandur · Bengaluru East",
        latitude=12.9260, longitude=77.6762,
        title="Flood expected in Bellandur in the next 36–48 hours",
        summary="Heavy rain is forecast over a saturated catchment while the nearby dam is almost full, "
                "so an uncontrolled overflow is likely.",
        reasons=["142 mm of rain is forecast in the next 48 hours near Bellandur.",
                 "The upstream reservoir is already at 96% capacity, leaving little buffer for more inflow."],
        rain24Mm=88, rainMm=142, rainWindowHours=48, rainSource="IMD · official",
        reservoirFillPct=96, reservoirSource="Gauge · sensor",
        floodRiskPct=82, landslideRiskPct=12, confidencePct=86,
        floodWindowHours="36-48", floodPeak="Thu 02:00",
        recommendedActions=[
            {"label": "Evacuate low-lying Bellandur and Kasavanahalli wards", "detail": "~2,300 people (est.)", "icon": "evacuate"},
            {"label": "Alert dam authority to start a slow, staged release", "detail": "Before Wed 22:00", "icon": "dam"},
            {"label": "Prepare relief shelters", "detail": "3 shelters · 1,800 beds", "icon": "shelter"},
        ],
        approvalStatus="awaiting_approval", responsePlan=[],
        createdAt=_iso(now - timedelta(minutes=44)),
    )
    orr = alert(
        tier="severe", hazardType="waterlogging", place="Marathahalli ORR", area="Marathahalli ORR · Bengaluru East",
        latitude=12.9569, longitude=77.7011,
        title="Waterlogging on Outer Ring Road",
        summary="Intense short-duration rain over Marathahalli is overwhelming storm drains on the Outer Ring Road.",
        reasons=["78 mm of rain is forecast in the next 24 hours over Marathahalli.",
                 "Storm-drain sensors near Kadubeesanahalli are at 91% capacity."],
        rain24Mm=78, rainMm=78, rainWindowHours=24, rainSource="IMD · official",
        reservoirFillPct=91, reservoirSource="Drain sensor",
        floodRiskPct=68, landslideRiskPct=0, confidencePct=78,
        floodWindowHours="18-24", floodPeak="Wed 19:00",
        recommendedActions=[
            {"label": "Deploy de-watering pumps", "detail": "4 pumps", "icon": "pump"},
            {"label": "Traffic diversion at Kadubeesanahalli", "detail": "Police team", "icon": "traffic"},
            {"label": "Commuter advisory (SMS, WhatsApp)", "detail": "18,400 recipients", "icon": "alert"},
        ],
        approvalStatus="approved",
        responsePlan=[
            _step("Deploy de-watering pumps", "4 pumps", "completed", "4 of 4 on site"),
            _step("Traffic diversion at Kadubeesanahalli", "Police team", "in_field", "Police on site"),
            _step("Commuter advisory (SMS, WhatsApp)", "18,400 recipients", "completed", "18,400 sent"),
        ],
        createdAt=_iso(now - timedelta(hours=3, minutes=10)),
        approvedAt=_iso(now - timedelta(hours=2, minutes=50)),
        planApprovedAt=_iso(now - timedelta(hours=2, minutes=35)),
        decisionLog=[{"action": "approve", "actor": "Incident Commander", "at": _iso(now - timedelta(hours=2, minutes=50)), "revision": 1}],
    )
    yelahanka = alert(
        tier="moderate", hazardType="wind", place="Yelahanka", area="Yelahanka · Bengaluru North",
        latitude=13.1007, longitude=77.5963,
        title="Strong gusts up to 48 km/h",
        summary="A passing thunderstorm cell may bring strong gusts and isolated tree falls in Yelahanka.",
        reasons=["Wind gusts up to 48 km/h are forecast for Yelahanka in the next 24–30 hours."],
        rain24Mm=22, rainMm=22, rainWindowHours=24, rainSource="IMD · official",
        reservoirFillPct=58, reservoirSource="Gauge · sensor",
        floodRiskPct=24, landslideRiskPct=0, confidencePct=71,
        floodWindowHours="24-30", floodPeak="Thu 16:00",
        recommendedActions=[
            {"label": "Tree-fall crews on standby", "detail": "2 crews", "icon": "team"},
            {"label": "Wind advisory in 3 languages", "detail": "Ready to send", "icon": "alert"},
        ],
        approvalStatus="approved",
        responsePlan=[
            _step("Tree-fall crews on standby", "2 crews", "awaiting_approval", "Held"),
            _step("Wind advisory in 3 languages", "Ready to send", "pending", "Drafted"),
        ],
        createdAt=_iso(now - timedelta(hours=1, minutes=20)),
        approvedAt=_iso(now - timedelta(hours=1, minutes=5)),
        decisionLog=[{"action": "approve", "actor": "Incident Commander", "at": _iso(now - timedelta(hours=1, minutes=5)), "revision": 1}],
    )
    heat = alert(
        tier="minor", hazardType="heat", place="Bengaluru Urban", area="Bengaluru Urban",
        latitude=12.9716, longitude=77.5946,
        title="Day temperature above normal",
        summary="Day temperatures are expected 2–3 °C above normal; no action is needed unless this rises to Moderate.",
        reasons=["Maximum temperature of 34 °C is forecast over the next 48–72 hours."],
        rain24Mm=0, rainMm=0, rainWindowHours=48, rainSource="IMD · official",
        reservoirFillPct=58, reservoirSource="Gauge · sensor",
        floodRiskPct=4, landslideRiskPct=0, confidencePct=64,
        floodWindowHours="48-72", floodPeak="",
        recommendedActions=[], approvalStatus=None, responsePlan=[],
        createdAt=_iso(now - timedelta(minutes=25)),
    )
    return [bellandur, orr, yelahanka, heat]


def seed_hazard_demo(state: dict[str, Any], now: datetime | None = None) -> None:
    """Loads the demo alerts into the state (once). Agent readings for the all-clear view come from real scans."""
    now = now or datetime.now(timezone.utc)
    if any(item.get("demoSeed") for item in state.get("hazardAlerts", [])):
        return
    state.setdefault("hazardAlerts", []).extend(demo_hazard_alerts(now))
