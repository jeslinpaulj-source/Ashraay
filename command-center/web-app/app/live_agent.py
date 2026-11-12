"""Live Hazard Intelligence agent helpers (location-independent).

Everything here is deliberately *location-free*: latitude/longitude, city and landmark values are
kept on records for display, but they are never used to filter, rank or target hazard alerts,
citizen notices or volunteer requests. Every alert reaches the Command Center, every dispatched
alert is published to every registered user, and every active volunteer is asked to respond.

Pure functions only (no FastAPI / database access) so they are easy to test.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

# Severity order used for ranking: never distance or place.
SEVERITY_RANK = {"high": 3, "medium": 2, "low": 1}
CITIZEN_ALERT_CITY_ID = "citizen-reports"
CITIZEN_ALERT_PLACE = "Citizen reports"


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:20]


# ---------------------------------------------------------------- rules fallback for Agent 1
def rule_confidence(rain_mm: float, reservoir_pct: float, flood_pct: float, severity: str | None) -> float:
    """Deterministic confidence used when the Copilot model is not configured or unavailable."""
    if severity == "high":
        strong = rain_mm >= 204.5 or (rain_mm >= 115 and reservoir_pct >= 90) or (reservoir_pct >= 95 and rain_mm >= 64.5)
        return 0.86 if strong else 0.74
    if severity == "medium":
        return 0.7 if (flood_pct >= 70 or reservoir_pct >= 92) else 0.64
    return 0.5


def rule_flood_window(severity: str | None) -> str:
    return {"high": "12-24", "medium": "24-48"}.get(severity or "", "48-72")


def rule_recommended_actions(place: str, severity: str | None, rain_mm: float, reservoir_pct: float) -> list[dict]:
    """Built-in recommendations for the Hazard Response Agent (used without a language model)."""
    actions: list[dict] = []
    if severity == "high":
        actions.append({"label": f"Evacuate low-lying areas around {place}", "detail": "Start with homes nearest the water", "icon": "evacuate"})
        if reservoir_pct >= 80:
            actions.append({"label": "Alert dam authority to start a slow, staged release", "detail": f"Reservoir at {round(reservoir_pct)}%", "icon": "dam"})
        actions.append({"label": "Prepare relief shelters", "detail": "Open the nearest shelters and stock supplies", "icon": "shelter"})
        actions.append({"label": "Pre-position rescue boats and teams", "detail": "Keep them ready to move", "icon": "team"})
    elif severity == "medium":
        actions.append({"label": "Put response teams on standby", "detail": "Ready to move within an hour", "icon": "team"})
        actions.append({"label": "Issue a public advisory", "detail": f"{round(rain_mm)} mm rain expected", "icon": "alert"})
        if reservoir_pct >= 80:
            actions.append({"label": "Ask the dam authority to monitor inflow closely", "detail": f"Reservoir at {round(reservoir_pct)}%", "icon": "dam"})
    return actions[:6]


# ---------------------------------------------------------------- user (citizen) signals
def latest_checkins_by_person(checkins: list[dict]) -> list[dict]:
    latest: dict[str, dict] = {}
    for item in checkins:
        owner = item.get("owner") or item.get("id")
        if owner not in latest or str(item.get("time", "")) >= str(latest[owner].get("time", "")):
            latest[owner] = item
    return list(latest.values())


def citizen_signals(state: dict) -> dict:
    """Counts of open citizen reports and check-ins across the whole system (no location filter)."""
    open_incidents = [item for item in state.get("incidents", []) if item.get("status") not in ("resolved", "dismissed")]
    # Reports not yet grouped into an incident by A1 still count, so new reports are acted on at once.
    new_reports = [item for item in state.get("reports", []) if item.get("status") == "received"]
    latest = latest_checkins_by_person(state.get("checkins", []))
    return {
        "reports": len(state.get("reports", [])),
        "openIncidents": len(open_incidents) + len(new_reports),
        "verifiedIncidents": sum(1 for item in open_incidents if item.get("status") == "verified"),
        "peopleReported": sum(int(item.get("reportedPeople") or 0) for item in open_incidents)
        + sum(int(item.get("people") or 0) for item in new_reports),
        "checkins": len(state.get("checkins", [])),
        "needHelp": sum(1 for item in latest if item.get("status") == "need_help"),
        "atRisk": sum(1 for item in latest if item.get("status") == "at_risk"),
        "safe": sum(1 for item in latest if item.get("status") == "safe"),
    }


def citizen_severity(signals: dict) -> str | None:
    if signals["needHelp"] >= 5 or signals["peopleReported"] >= 10:
        return "high"
    if signals["needHelp"] or signals["peopleReported"] or signals["openIncidents"] or signals["atRisk"] >= 3:
        return "medium"
    return None


def citizen_reasons(signals: dict) -> list[str]:
    reasons = []
    if signals["openIncidents"]:
        reasons.append(
            f"{signals['openIncidents']} open citizen incident report(s), {signals['peopleReported']} people reported needing help."
        )
    if signals["needHelp"] or signals["atRisk"]:
        reasons.append(f"{signals['needHelp']} check-in(s) asked for help and {signals['atRisk']} reported being at risk.")
    return reasons or ["New citizen reports were received."]


def citizen_recommended_actions(signals: dict) -> list[dict]:
    actions = []
    if signals["needHelp"] or signals["peopleReported"]:
        people = max(signals["needHelp"], signals["peopleReported"])
        actions.append({"label": "Send a rescue team to people who asked for help", "detail": f"{people} people", "icon": "team"})
        actions.append({"label": "Call back people who asked for help", "detail": f"{signals['needHelp']} check-ins", "icon": "alert"})
    if signals["openIncidents"] - signals["verifiedIncidents"] > 0:
        actions.append({"label": "Verify the open citizen reports", "detail": f"{signals['openIncidents'] - signals['verifiedIncidents']} awaiting review", "icon": "alert"})
    if signals["atRisk"]:
        actions.append({"label": "Warn people who reported being at risk", "detail": f"{signals['atRisk']} check-ins", "icon": "alert"})
    return actions[:6] or [{"label": "Review the new citizen reports", "detail": "", "icon": "alert"}]


def update_note(signals: dict, previous: dict | None) -> dict | None:
    """Short 'what changed' note the agent attaches to an active alert when user events arrive."""
    if previous is None:
        return None
    new_reports = signals["reports"] - previous.get("reports", 0)
    new_checkins = signals["checkins"] - previous.get("checkins", 0)
    if new_reports <= 0 and new_checkins <= 0:
        return None
    parts = []
    if new_reports > 0:
        parts.append(f"{new_reports} new citizen report(s)")
    if new_checkins > 0:
        parts.append(f"{new_checkins} new check-in(s)")
    recommendation = (
        "Send a rescue team to people who asked for help." if signals["needHelp"]
        else "Verify the new reports before acting." if signals["openIncidents"]
        else "Keep monitoring."
    )
    return {
        "text": ", ".join(parts) + f"; {signals['needHelp']} need help now.",
        "recommendation": recommendation,
        "newReports": max(new_reports, 0),
        "newCheckins": max(new_checkins, 0),
        "needHelp": signals["needHelp"],
    }


# ---------------------------------------------------------------- dispatch to everyone
def active_volunteers(volunteers: list[dict]) -> list[dict]:
    """Every verified volunteer who marked themselves available. Location is never consulted."""
    return [item for item in volunteers if item.get("status") == "verified" and item.get("available")]


def citizen_notice(alert: dict) -> dict:
    """Plain-language notice published to every registered user when an alert is dispatched."""
    place = alert.get("area") or alert.get("place") or ""
    title = alert.get("title") or f"{(alert.get('hazardType') or 'flood').capitalize()} warning for {place}"
    steps = [action.get("label", "") for action in (alert.get("recommendedActions") or []) if action.get("label")]
    summary = alert.get("summary") or (alert.get("reasons") or [""])[0]
    message = summary.strip()
    if steps:
        message = (message + " " if message else "") + "Response under way: " + "; ".join(steps[:3]) + "."
    message += " Follow official instructions and use the app to check in."
    return {"place": place, "language": "en", "headline": title, "message": message[:600]}
