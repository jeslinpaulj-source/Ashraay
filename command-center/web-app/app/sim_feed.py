"""Reads live hazard signals from the ASHRAAY Hazard Simulator (ashraay-sim) and converts them
into the rain / flood-risk / reservoir numbers Agent 1 expects.

ashraay-sim exposes the same `/api/snapshot` document that `ashraay-sim/monitor.py` watches:
    areas[]      ward/district rain forecasts, 5 days, each with a status + rain_mm
    stations[]   river gauges with current/forecast/danger/HFL levels
    reservoirs[] dams with storage_pct and FRL

A Command Center city is matched to sim records by nearest latitude/longitude, so no hardcoded
city -> sim id table has to be maintained.
"""
from __future__ import annotations

import hashlib
import os
import time

import httpx

SIM_BASE_URL = os.getenv("ASHRAAY_SIM_URL", "http://localhost:8080").rstrip("/")
SIM_TOKEN = os.getenv("FFS_SIM_TOKEN", "")
SNAPSHOT_TTL_SEC = float(os.getenv("ASHRAAY_SIM_TTL", "5"))

# Rain status -> the flood-risk percentage Agent 1 reasons about, mirroring the simulator's own tiers.
STATUS_FLOOD_PCT = {"normal": 10.0, "above_normal": 45.0, "severe": 75.0, "extreme": 95.0}
STATUS_RANK = {"normal": 0, "above_normal": 1, "severe": 2, "extreme": 3}

_cache: dict | None = None
_cache_at = 0.0


class SimFeedError(RuntimeError):
    """The simulator could not be reached or returned something unusable."""


async def fetch_snapshot(force: bool = False) -> dict:
    """Returns the simulator snapshot, cached briefly so a tight agent loop doesn't hammer it."""
    global _cache, _cache_at
    if not force and _cache is not None and (time.monotonic() - _cache_at) < SNAPSHOT_TTL_SEC:
        return _cache
    headers = {"X-Sim-Token": SIM_TOKEN} if SIM_TOKEN else {}
    try:
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            response = await client.get(f"{SIM_BASE_URL}/api/snapshot", headers=headers)
            response.raise_for_status()
            snapshot = response.json()
    except Exception as exc:
        raise SimFeedError(
            f"Could not read the ASHRAAY Hazard Simulator at {SIM_BASE_URL} ({exc.__class__.__name__}). "
            "Start it with ashraay-sim/start.bat, or set ASHRAAY_SIM_URL."
        ) from exc
    if not isinstance(snapshot, dict) or "areas" not in snapshot:
        raise SimFeedError(f"{SIM_BASE_URL}/api/snapshot did not return a simulator snapshot.")
    _cache, _cache_at = snapshot, time.monotonic()
    return snapshot


def _area_signal(area: dict) -> tuple[float, float, int, str]:
    """Peak rain in the simulator forecast horizon and its highest stated risk tier."""
    days = area.get("days") or []
    today = days[0] if days else {}
    rain24 = float(today.get("rain_mm") or 0)
    peak_index, peak_day = max(
        enumerate(days), key=lambda pair: float(pair[1].get("rain_mm") or 0), default=(0, today)
    )
    rain_peak = float(peak_day.get("rain_mm") or 0)
    worst = max(
        (d.get("status", "normal") for d in days),
        key=lambda status: STATUS_RANK.get(status, 0),
        default="normal",
    )
    return rain24, rain_peak, max(24, (peak_index + 1) * 24), worst


def _station_signal(station: dict) -> tuple[float, str]:
    """How much flood pressure the nearest river gauge shows, on the simulator's own status tiers.

    River levels are absolute elevations (metres above sea level), so a percentage of the level
    itself is meaningless - the gauge's published status is the reliable signal. Crossing the
    danger mark only adds on top of that.
    """
    status = station.get("status", "normal")
    pct = STATUS_FLOOD_PCT.get(status, 10.0)
    danger = float(station.get("danger_level") or 0)
    hfl = float(station.get("hfl") or 0)
    level = max(float(station.get("current_level") or 0), float(station.get("forecast_level") or 0))
    if danger > 0 and level >= danger:
        span = max(hfl - danger, 0.5)
        pct = max(pct, min(100.0, 80 + 20 * (level - danger) / span))
    return pct, status


def _severity_rank(rain_mm: float, flood_pct: float, reservoir_pct: float) -> tuple[int, float]:
    if rain_mm >= 115 or (rain_mm >= 64.5 and reservoir_pct >= 85) or (reservoir_pct >= 95 and rain_mm >= 15):
        return 2, max(rain_mm / 115, flood_pct / 70, reservoir_pct / 92)
    if rain_mm >= 64.5 or (rain_mm >= 15 and reservoir_pct >= 80) or reservoir_pct >= 92 or flood_pct >= 70:
        return 1, max(rain_mm / 64.5, flood_pct / 70, reservoir_pct / 92)
    return 0, max(rain_mm / 64.5, flood_pct / 70, reservoir_pct / 92)


def _candidate(kind: str, item: dict, *, rain24: float = 0, rain_peak: float = 0,
               rain_window: int = 24, flood_pct: float = 0, reservoir_pct: float = 0,
               status: str = "normal", details: dict | None = None) -> dict | None:
    # Location is display-only: a source without coordinates is still a valid hazard signal.
    if not item.get("id"):
        return None
    name = str(item.get("name") or item["id"])
    locality = ", ".join(str(value) for value in (item.get("district"), item.get("state")) if value)
    place = f"{name} ({locality})" if locality else name
    source_id = str(item["id"])
    city_id = "sim-" + hashlib.sha256(f"{kind}:{source_id}".encode()).hexdigest()[:16]
    rain_peak = round(rain_peak, 1)
    flood_pct = min(100.0, round(flood_pct, 1))
    reservoir_pct = min(100.0, round(reservoir_pct, 1))
    severity_rank, intensity = _severity_rank(rain_peak, flood_pct, reservoir_pct)
    return {
        "cityId": city_id,
        "place": place[:120],
        "latitude": float(item["lat"]) if item.get("lat") is not None else None,
        "longitude": float(item["lon"]) if item.get("lon") is not None else None,
        "rain24Mm": round(rain24, 1),
        "rainMm": rain_peak,
        "rainWindowHours": rain_window,
        "floodRiskPct": flood_pct,
        "landslideRiskPct": min(100.0, round(rain_peak * 0.45, 1)),
        "reservoirFillPct": reservoir_pct,
        "status": status,
        "severityRank": severity_rank,
        "intensity": intensity,
        "source": {
            "kind": kind,
            "id": source_id,
            "name": name,
            "place": locality,
            "status": status,
            **(details or {}),
        },
    }


def simulator_candidates(snapshot: dict) -> list[dict]:
    """Every usable source in the simulator snapshot (areas, river gauges, reservoirs), any location."""
    candidates: list[dict] = []
    areas = snapshot.get("areas") or []
    stations = snapshot.get("stations") or []
    reservoirs = snapshot.get("reservoirs") or []

    for area in areas:
        rain24, rain_peak, rain_window, status = _area_signal(area)
        candidates.append(_candidate(
            "area", area, rain24=rain24, rain_peak=rain_peak, rain_window=rain_window,
            flood_pct=STATUS_FLOOD_PCT.get(status, 10.0), status=status,
            details={"areaKind": area.get("area_kind")},
        ))

    for station in stations:
        flood_pct, status = _station_signal(station)
        candidates.append(_candidate(
            "station", station, flood_pct=flood_pct, status=status,
            details={"river": station.get("river"), "levelM": station.get("current_level"),
                     "forecastM": station.get("forecast_level"), "dangerM": station.get("danger_level")},
        ))

    for reservoir in reservoirs:
        fill_pct = float(reservoir.get("storage_pct") or 0)
        candidates.append(_candidate(
            "reservoir", reservoir, reservoir_pct=fill_pct, status=str(reservoir.get("status") or "normal"),
            details={"frlM": reservoir.get("frl"), "levelM": reservoir.get("current_level"),
                     "inflowCumecs": reservoir.get("inflow_cumecs")},
        ))

    return [candidate for candidate in candidates if candidate is not None]


def simulator_signals(snapshot: dict) -> dict:
    """Selects the highest-risk individual source across the full simulator snapshot."""
    candidates = simulator_candidates(snapshot)
    areas = snapshot.get("areas") or []
    stations = snapshot.get("stations") or []
    reservoirs = snapshot.get("reservoirs") or []
    counts = {"areas": len(areas), "stations": len(stations), "reservoirs": len(reservoirs)}
    warnings = [
        {"title": warning.get("title"), "severity": warning.get("severity"), "message": warning.get("message")}
        for warning in (snapshot.get("warnings") or []) if warning.get("origin") == "manual"
    ][:5]
    metadata = {
        "matched": bool(candidates),
        "sourceCounts": counts,
        "warnings": warnings,
        "generatedAt": snapshot.get("generated_at"),
        "simVersion": snapshot.get("version"),
        "simUrl": SIM_BASE_URL,
    }
    if not candidates:
        return {
            "cityId": "ashraay-simulator",
            "place": "ASHRAAY Simulator",
            "latitude": None,
            "longitude": None,
            "rain24Mm": 0,
            "rainMm": 0,
            "rainWindowHours": 24,
            "floodRiskPct": 0,
            "landslideRiskPct": 0,
            "reservoirFillPct": 0,
            "source": None,
            **metadata,
        }

    winner = max(candidates, key=lambda candidate: (candidate["severityRank"], candidate["intensity"]))
    return {
        **{key: value for key, value in winner.items() if key not in {"severityRank", "intensity"}},
        "sources": [winner["source"]],
        **metadata,
    }


async def simulator_feed(force: bool = False) -> dict:
    return simulator_signals(await fetch_snapshot(force=force))
