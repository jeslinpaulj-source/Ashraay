"""Middle layer: business rules, validation, warnings and live-update events.

HTTP handlers call only these functions; these call the repository and publish
events on the bus so every open browser (and the monitor) updates immediately.
"""
import time
from datetime import date, datetime, timedelta, timezone

from . import config
from .db import Repository, STORAGE_EXP, now_iso
from .events import bus

ORDER = ["normal", "above_normal", "severe", "extreme"]
LABEL = {"normal": "Normal", "above_normal": "Above Normal", "severe": "Severe", "extreme": "Extreme"}
RES_LABEL = {"normal": "Normal", "above_normal": "High storage (≥80%)",
             "severe": "Very high (≥90%) - release likely", "extreme": "At / above FRL"}
WX_LABEL = {"normal": "Green - no warning", "above_normal": "Yellow - be aware",
            "severe": "Orange - be prepared", "extreme": "Red - take action"}
WX_SHORT = {"normal": "Green", "above_normal": "Yellow", "severe": "Orange", "extreme": "Red"}

# IMD rainfall categories (24-hour rainfall, mm)
RAIN_CATS = [
    (0.0, "no_rain", "No rain"), (0.1, "very_light", "Very light rain"), (2.5, "light", "Light rain"),
    (15.6, "moderate", "Moderate rain"), (64.5, "heavy", "Heavy rain"), (115.6, "very_heavy", "Very heavy rain"),
    (204.5, "extremely_heavy", "Extremely heavy rain"),
]
RAIN_STATUS = {"heavy": "above_normal", "very_heavy": "severe", "extremely_heavy": "extreme"}


class ValidationError(ValueError):
    pass


class NotFound(LookupError):
    pass


def worse(a, b):
    return a if ORDER.index(a) >= ORDER.index(b) else b


def worst(items):
    out = "normal"
    for s in items:
        out = worse(out, s)
    return out


def classify_level(level, wl, dl, hfl):
    if level is None:
        return "normal"
    if level >= hfl:
        return "extreme"
    if level >= dl:
        return "severe"
    if level >= wl:
        return "above_normal"
    return "normal"


def storage_pct(level, frl, mddl):
    if level <= mddl:
        return 0.0
    frac = (level - mddl) / (frl - mddl)
    return round(min(frac, 1.2) ** STORAGE_EXP * 100, 1)


def classify_reservoir(level, frl, pct):
    if level >= frl:
        return "extreme"
    if pct >= 90:
        return "severe"
    if pct >= 80:
        return "above_normal"
    return "normal"


def rain_category(mm):
    if mm is None or mm <= 0:
        return RAIN_CATS[0][1], RAIN_CATS[0][2]
    key, label = RAIN_CATS[1][1], RAIN_CATS[1][2]
    for lo, k, lbl in RAIN_CATS[1:]:
        if mm >= lo:
            key, label = k, lbl
    return key, label


def classify_day(d):
    """IMD-style colour for one forecast day from rain, wind gust and heat. Returns (status, reasons)."""
    cat, cat_label = rain_category(d["rain_mm"])
    reasons, st = [], "normal"
    if cat in RAIN_STATUS:
        st = RAIN_STATUS[cat]; reasons.append(f"{cat_label} {d['rain_mm']:g} mm")
    g = d["gust_kmh"] or 0
    gs = "extreme" if g >= 90 else "severe" if g >= 70 else "above_normal" if g >= 50 else "normal"
    if gs != "normal":
        st = worse(st, gs); reasons.append(f"Wind gusts {g:.0f} km/h")
    t = d["tmax"]
    ts = "extreme" if t >= 47 else "severe" if t >= 45 else "above_normal" if t >= 42 else "normal"
    if ts != "normal":
        st = worse(st, ts); reasons.append(f"Heat {t:.0f} C")
    return st, reasons


def condition(d):
    r, c, g = d["rain_mm"], d["chance"], d["gust_kmh"] or 0
    if r >= 15.6 and g >= 40:
        return "storm", "Thunderstorm with rain"
    if r >= 64.5:
        return "heavy_rain", rain_category(r)[1]
    if r >= 2.5:
        return "rain", rain_category(r)[1]
    if r > 0:
        return "drizzle", "Very light rain"
    if c >= 50:
        return "cloud", "Cloudy"
    if c >= 25:
        return "partly", "Partly cloudy"
    return "sun", "Mostly sunny"


def _num(body, key, required=True, lo=None, hi=None):
    v = body.get(key)
    if v in (None, ""):
        if required:
            raise ValidationError(f"'{key}' is required")
        return None
    if isinstance(v, bool):
        raise ValidationError(f"'{key}' must be a number")
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise ValidationError(f"'{key}' must be a number")
    if v != v or v in (float("inf"), float("-inf")):
        raise ValidationError(f"'{key}' must be a finite number")
    if lo is not None and v < lo:
        raise ValidationError(f"'{key}' must be >= {lo:g}")
    if hi is not None and v > hi:
        raise ValidationError(f"'{key}' must be <= {hi:g}")
    return round(v, 2)


def _text(body, key, maxlen=300, required=False):
    v = body.get(key)
    v = "" if v is None else str(v).strip()
    if required and not v:
        raise ValidationError(f"'{key}' is required")
    return v[:maxlen]


def day_label(d_iso, idx):
    d = date.fromisoformat(d_iso)
    return "Today" if idx == 0 else "Tomorrow" if idx == 1 else d.strftime("%a %d %b")


class HazardService:
    def __init__(self, repo=None):
        self.repo = repo or Repository()
        self.monitor = {"last_seen": 0, "info": {}}
        self.repo.roll_forecast()
        self._sync_all_auto_warnings()

    # ================= flood views =================
    def station_view(self, s):
        cur = classify_level(s["current_level"], s["warning_level"], s["danger_level"], s["hfl"])
        fc = classify_level(s["forecast_level"], s["warning_level"], s["danger_level"], s["hfl"])
        st = worse(cur, fc)
        return {**s, "kind": "station", "status_current": cur, "status_forecast": fc,
                "status": st, "status_label": LABEL[st],
                "above_danger_by": round(s["current_level"] - s["danger_level"], 2)}

    def reservoir_view(self, r):
        pct = storage_pct(r["current_level"], r["frl"], r["mddl"])
        st = classify_reservoir(r["current_level"], r["frl"], pct)
        return {**r, "kind": "reservoir", "storage_pct": pct,
                "live_storage_mcm": round(r["live_capacity_mcm"] * min(pct, 100) / 100, 0),
                "below_frl_by": round(r["frl"] - r["current_level"], 2),
                "status": st, "status_label": RES_LABEL[st]}

    # ================= weather views =================
    def day_view(self, f, full=True):
        st, reasons = classify_day(f)
        cat, cat_label = rain_category(f["rain_mm"])
        icon, cond = condition(f)
        d = {"rain_mm": f["rain_mm"], "chance": f["chance"], "tmax": f["tmax"], "tmin": f["tmin"],
             "humidity": f["humidity"], "wind_kmh": f["wind_kmh"], "gust_kmh": f["gust_kmh"],
             "rain_cat": cat, "icon": icon, "status": st, "src": "sim" if f["source"] == "simulation" else "seed"}
        if reasons:
            d["reasons"] = reasons
        if full:
            d.update({"day_idx": f["day_idx"], "date": f["date"], "label": day_label(f["date"], f["day_idx"]),
                      "rain_cat_label": cat_label, "condition": cond, "status_label": WX_LABEL[st],
                      "reasons": reasons, "updated_at": f["updated_at"]})
        return d

    def area_view(self, a, rows, full=True):
        days = [self.day_view(f, full) for f in rows]
        st5 = worst(d["status"] for d in days)
        st2 = worst(d["status"] for d in days[:2])
        peak = max(range(len(days)), key=lambda i: (ORDER.index(days[i]["status"]), days[i]["rain_mm"])) if days else 0
        return {**a, "area_kind": a["kind"], "kind": "area", "days": days, "status": st5, "status_2d": st2,
                "status_label": WX_LABEL[st5], "peak_day": peak,
                "max_rain_mm": max((d["rain_mm"] for d in days), default=0),
                "source": "simulation" if any(d["src"] == "sim" for d in days) else "seed",
                "updated_at": max((f["updated_at"] for f in rows), default=None)}

    def weather(self):
        self._maybe_roll()
        by = {}
        for f in self.repo.forecast_all():
            by.setdefault(f["area_id"], []).append(f)
        areas = [self.area_view(a, by.get(a["id"], []), full=False) for a in self.repo.areas()]
        first = by.get(areas[0]["id"], []) if areas else []
        dates = [f["date"] for f in first]
        return areas, dates

    def _maybe_roll(self):
        if self.repo.roll_forecast():
            self._sync_all_auto_warnings()
            bus.publish("rollover", message="New forecast day started")

    # ================= snapshot =================
    def snapshot(self):
        areas, dates = self.weather()
        st = [self.station_view(s) for s in self.repo.stations()]
        rs = [self.reservoir_view(r) for r in self.repo.reservoirs()]

        def count(items, key="status"):
            c = {k: 0 for k in ORDER}
            for x in items:
                c[x[key]] += 1
            return c
        per_day = []
        for i in range(len(dates)):
            per_day.append(count([{"status": a["days"][i]["status"]} for a in areas if len(a["days"]) > i]))
        return {"version": bus.version, "generated_at": now_iso(),
                "dates": [{"date": d, "label": day_label(d, i)} for i, d in enumerate(dates)],
                "summary": {"stations": count(st), "reservoirs": count(rs), "areas_5d": count(areas),
                            "areas_2d": count(areas, "status_2d"), "areas_per_day": per_day,
                            "station_total": len(st), "reservoir_total": len(rs), "area_total": len(areas)},
                "stations": st, "reservoirs": rs, "areas": areas,
                "warnings": self.repo.warnings(True), "monitor": self.monitor_status()}

    def station(self, sid):
        s = self.repo.station(sid)
        if not s:
            raise NotFound(f"station {sid} not found")
        return {**self.station_view(s), "history": self.repo.history("station", sid)}

    def reservoir(self, rid):
        r = self.repo.reservoir(rid)
        if not r:
            raise NotFound(f"reservoir {rid} not found")
        return {**self.reservoir_view(r), "history": self.repo.history("reservoir", rid)}

    def area(self, aid):
        self._maybe_roll()
        a = self.repo.area(aid)
        if not a:
            raise NotFound(f"area {aid} not found")
        return self.area_view(a, self.repo.forecast_for(aid))

    def meta(self):
        res_tree, wx_tree = {}, {}
        for r in self.repo.reservoirs():
            res_tree.setdefault(r["state"], {}).setdefault(r["district"], []).append({"id": r["id"], "name": r["name"]})
        for a in self.repo.areas():
            wx_tree.setdefault(a["state"], {}).setdefault(a["district"], []).append(
                {"id": a["id"], "name": a["name"], "kind": a["kind"]})
        st = self.repo.stations()
        return {"reservoir_tree": res_tree, "weather_tree": wx_tree,
                "basins": sorted({s["basin"] for s in st}),
                "stations": [{"id": s["id"], "name": s["name"], "river": s["river"], "basin": s["basin"],
                              "state": s["state"], "district": s["district"]} for s in st]}

    # ================= simulation: weather =================
    def _areas_in_scope(self, body):
        scope = _text(body, "scope", 20) or "ward"
        if scope == "ward":
            aid = _text(body, "area_id", 80, True)
            a = self.repo.area(aid)
            if not a:
                raise NotFound(f"area {aid} not found")
            return scope, [a], a["name"]
        state = _text(body, "state", 80, True)
        if scope == "district":
            dist = _text(body, "district", 80, True)
            sel = [a for a in self.repo.areas() if a["state"] == state and a["district"] == dist]
            label = f"{dist}, {state}"
        elif scope == "state":
            sel = [a for a in self.repo.areas() if a["state"] == state]
            label = state
        else:
            raise ValidationError("scope must be ward, district or state")
        if not sel:
            raise NotFound("no forecast areas match that scope")
        return scope, sel, label

    def simulate_rain(self, body, client="?"):
        self._maybe_roll()
        scope, areas, label = self._areas_in_scope(body)
        day = int(_num(body, "day", True, 0, config.FORECAST_DAYS - 1))
        unit = (_text(body, "unit", 4) or "mm").lower()
        if unit not in ("mm", "cm"):
            raise ValidationError("unit must be mm or cm")
        rain = _num(body, "rain", True, 0, 100 if unit == "cm" else 1000)
        rain_mm = round(rain * (10 if unit == "cm" else 1), 1)
        chance = _num(body, "chance", False, 0, 100)
        tmax = _num(body, "tmax", False, -10, 55)
        wind = _num(body, "wind_kmh", False, 0, 250)
        gust = _num(body, "gust_kmh", False, 0, 300)
        propagate = bool(body.get("propagate"))
        note = _text(body, "note")
        ts = now_iso()
        deltas = {}
        for a in areas:
            old = next((f for f in self.repo.forecast_for(a["id"]) if f["day_idx"] == day), None)
            if not old:
                continue
            f = {"rain_mm": rain_mm, "source": "simulation", "updated_at": ts,
                 "chance": int(chance) if chance is not None else int(min(98, max(old["chance"], 40 + rain_mm * 0.6) if rain_mm else min(old["chance"], 15))),
                 "humidity": int(min(98, 50 + rain_mm / 2)) if rain_mm else old["humidity"]}
            if tmax is not None:
                f["tmax"] = tmax; f["tmin"] = round(min(old["tmin"], tmax - 6), 1)
            if wind is not None:
                f["wind_kmh"] = wind
                f["gust_kmh"] = gust if gust is not None else round(wind * 1.5, 0)
            elif gust is not None:
                f["gust_kmh"] = gust
            self.repo.update_forecast(a["id"], day, **f)
            key = (a["state"], a["district"])
            deltas[key] = max(deltas.get(key, 0), rain_mm - old["rain_mm"])
            self._sync_area_warning(a["id"], note)
        impacted = []
        if propagate:
            impacted = self._propagate(deltas, ts, f"Rain simulation ({label}, day {day + 1})")
        dates = self.repo.forecast_for(areas[0]["id"])
        dlabel = day_label(dates[day]["date"], day) if dates else f"day {day + 1}"
        cat_label = rain_category(rain_mm)[1]
        self.repo.add_audit("simulate_rain", scope, label,
                            {"day": day, "date": dates[day]["date"] if dates else None, "rain_mm": rain_mm,
                             "areas": len(areas), "propagate": propagate, "impacted": impacted, "note": note}, client)
        st, _ = classify_day({"rain_mm": rain_mm, "gust_kmh": gust or (wind * 1.5 if wind else 0), "tmax": tmax or 0})
        bus.publish("weather", target_type="area", target_id=areas[0]["id"] if len(areas) == 1 else "",
                    status=st, message=f"Rain {rain_mm:g} mm ({cat_label}) set for {label} - {dlabel}")
        return {"areas": [a["id"] for a in areas], "rain_mm": rain_mm, "rain_cat_label": cat_label,
                "day": day, "date_label": dlabel, "impacted": impacted,
                "area": self.area(areas[0]["id"]) if len(areas) == 1 else None}

    def _propagate(self, deltas, ts, note):
        """Simple hydrology stand-in: extra rain raises river forecasts and dam inflow in the same district."""
        out = []
        for s in self.repo.stations():
            d = deltas.get((s["state"], s["district"]), 0)
            if d <= 0:
                continue
            fc = round(s["forecast_level"] + min(5.0, d / 100.0), 2)
            self.repo.update_station(s["id"], forecast_level=fc, trend="rising", updated_at=ts, source="simulation")
            self._sync_auto_warning(self.station_view(self.repo.station(s["id"])), note)
            out.append(s["id"])
        for r in self.repo.reservoirs():
            d = deltas.get((r["state"], r["district"]), 0)
            if d <= 0:
                continue
            self.repo.update_reservoir(r["id"], inflow_cumecs=round(r["inflow_cumecs"] + d * 20, 0),
                                       updated_at=ts, source="simulation")
            out.append(r["id"])
        return out

    # ================= simulation: rivers & dams =================
    def simulate_station(self, sid, body, client="?"):
        s = self.repo.station(sid)
        if not s:
            raise NotFound(f"station {sid} not found")
        lo, hi = s["warning_level"] - 30, s["hfl"] + 15
        level = _num(body, "level", True, lo, hi)
        fc = _num(body, "forecast_level", False, lo, hi)
        hours = _num(body, "forecast_hours", False, 1, 120) or 12
        note = _text(body, "note")
        prev = s["current_level"]
        trend = "rising" if level > prev + 0.01 else "falling" if level < prev - 0.01 else "steady"
        if fc is None:
            fc = round(level + (s["forecast_level"] - prev), 2)
        ts = now_iso()
        self.repo.update_station(sid, current_level=level, forecast_level=fc,
                                 forecast_for=now_iso(datetime.now(timezone.utc) + timedelta(hours=hours)),
                                 trend=trend, updated_at=ts, source="simulation")
        self.repo.add_observation("station", sid, ts, level)
        view = self.station_view(self.repo.station(sid))
        w = self._sync_auto_warning(view, note)
        self.repo.add_audit("simulate_station", "station", sid, {"from": prev, "to": level, "forecast": fc, "note": note}, client)
        bus.publish("station", target_type="station", target_id=sid, name=s["name"], status=view["status"], level=level,
                    message=f"{s['name']} ({s['river']}): {level:.2f} m - {LABEL[view['status']]}")
        return {"station": view, "warning": w}

    def simulate_reservoir(self, rid, body, client="?"):
        r = self.repo.reservoir(rid)
        if not r:
            raise NotFound(f"reservoir {rid} not found")
        lo, hi = r["mddl"] - 20, r["frl"] + 10
        level = _num(body, "level", True, lo, hi)
        inflow = _num(body, "inflow_cumecs", False, 0, 200000)
        outflow = _num(body, "outflow_cumecs", False, 0, 200000)
        note = _text(body, "note")
        prev = r["current_level"]
        ts = now_iso()
        f = {"current_level": level, "updated_at": ts, "source": "simulation"}
        if inflow is not None:
            f["inflow_cumecs"] = inflow
        if outflow is not None:
            f["outflow_cumecs"] = outflow
        self.repo.update_reservoir(rid, **f)
        self.repo.add_observation("reservoir", rid, ts, level)
        view = self.reservoir_view(self.repo.reservoir(rid))
        w = self._sync_auto_warning(view, note)
        self.repo.add_audit("simulate_reservoir", "reservoir", rid,
                            {"from": prev, "to": level, "inflow": inflow, "outflow": outflow, "note": note}, client)
        bus.publish("reservoir", target_type="reservoir", target_id=rid, name=r["name"], status=view["status"], level=level,
                    message=f"{r['name']}: {level:.2f} m, {view['storage_pct']:.0f}% full - {view['status_label']}")
        return {"reservoir": view, "warning": w}

    def scenario(self, body, client="?"):
        basin = _text(body, "basin", 80, True)
        state = _text(body, "state", 80)
        delta = _num(body, "delta_m", True, -10, 10)
        changed, ts = [], now_iso()
        for s in self.repo.stations():
            if s["basin"] != basin or (state and s["state"] != state):
                continue
            lvl = round(s["current_level"] + delta, 2)
            self.repo.update_station(s["id"], current_level=lvl, forecast_level=round(s["forecast_level"] + delta, 2),
                                     trend="rising" if delta > 0 else "falling", updated_at=ts, source="simulation")
            self.repo.add_observation("station", s["id"], ts, lvl)
            self._sync_auto_warning(self.station_view(self.repo.station(s["id"])), f"Scenario: basin {basin} {delta:+.2f} m")
            changed.append(s["id"])
        if not changed:
            raise ValidationError("no stations match that basin/state")
        self.repo.add_audit("scenario", "basin", basin, {"state": state, "delta_m": delta, "stations": changed}, client)
        bus.publish("scenario", target_type="basin", target_id=basin, count=len(changed),
                    message=f"Scenario: {basin}{' / ' + state if state else ''} {delta:+.2f} m on {len(changed)} stations")
        return {"changed": changed}

    def create_warning(self, body, client="?"):
        sev = _text(body, "severity", 20, True)
        if sev not in ORDER[1:]:
            raise ValidationError("severity must be above_normal, severe or extreme")
        ttype = _text(body, "target_type", 20) or "area"
        tid = _text(body, "target_id", 80)
        if ttype == "station" and not self.repo.station(tid):
            raise NotFound("station not found")
        if ttype == "reservoir" and not self.repo.reservoir(tid):
            raise NotFound("reservoir not found")
        if ttype == "area" and tid and not self.repo.area(tid):
            raise NotFound("area not found")
        if ttype not in ("station", "reservoir", "area"):
            raise ValidationError("target_type must be station, reservoir or area")
        title = _text(body, "title", 120, True)
        msg = _text(body, "message", 600, True)
        wid = self.repo.add_warning(ttype, tid, sev, title, msg, "manual")
        self.repo.add_audit("create_warning", ttype, tid, {"id": wid, "severity": sev, "title": title}, client)
        bus.publish("warning", target_type=ttype, target_id=tid, warning_id=wid, status=sev,
                    message=f"New {LABEL[sev]} warning: {title}")
        return {"id": wid}

    def clear_warning(self, wid, client="?"):
        self.repo.clear_warning(wid)
        self.repo.add_audit("clear_warning", "warning", str(wid), {}, client)
        bus.publish("warning_cleared", warning_id=wid, message=f"Warning #{wid} cleared")
        return {"cleared": wid}

    def reset(self, client="?"):
        self.repo.seed()
        self._sync_all_auto_warnings()
        self.repo.add_audit("reset", "all", "", {}, client)
        bus.publish("reset", message="All data reset to seed values")
        return {"reset": True}

    # ================= monitor =================
    def monitor_status(self):
        age = time.time() - self.monitor["last_seen"] if self.monitor["last_seen"] else None
        return {"online": age is not None and age <= config.MONITOR_ONLINE_SEC,
                "last_seen_sec": None if age is None else round(age, 1), **self.monitor["info"]}

    def monitor_heartbeat(self, body):
        self.monitor["last_seen"] = time.time()
        self.monitor["info"] = {k: body.get(k) for k in ("host", "pid", "started_at", "watching", "min_level", "log_file")}
        return self.monitor_status()

    def monitor_report(self, body, client="?"):
        events = body.get("events")
        if not isinstance(events, list) or not events:
            raise ValidationError("'events' must be a non-empty list")
        n = 0
        for e in events[:200]:
            if not isinstance(e, dict):
                continue
            rec = {"ts": _text(e, "ts", 40), "change": _text(e, "change", 20, True), "level": _text(e, "level", 20, True),
                   "kind": _text(e, "kind", 20, True), "target_id": _text(e, "target_id", 80),
                   "name": _text(e, "name", 160, True), "place": _text(e, "place", 160),
                   "detail": e.get("detail") if isinstance(e.get("detail"), dict) else {}}
            self.repo.add_monitor_event(rec)
            n += 1
        self.monitor["last_seen"] = time.time()
        bus.publish("monitor", count=n, message=f"Monitor reported {n} change(s)")
        return {"stored": n}

    def monitor_log(self):
        return {"status": self.monitor_status(), "events": self.repo.monitor_events()}

    def clear_monitor_log(self, client="?"):
        self.repo.clear_monitor_events()
        bus.publish("monitor", count=0, message="Monitor log cleared")
        return {"cleared": True}

    # ================= warnings =================
    def _sync_area_warning(self, aid, note=""):
        a = self.repo.area(aid)
        view = self.area_view(a, self.repo.forecast_for(aid))
        existing = self.repo.active_auto_warning("area", aid)
        sev = view["status"]
        if sev not in ("severe", "extreme"):      # weather warnings only for Orange / Red
            if existing:
                self.repo.clear_warning(existing["id"])
            return None
        d = view["days"][view["peak_day"]]
        where = view["name"] if view["area_kind"] == "ward" else view["district"]
        title = f"{WX_SHORT[sev]} alert - {', '.join(d['reasons']) or d['condition']} - {where} ({view['district']}) {d['label']}"
        msg = (f"{d['label']}, {d['date']}: {d['rain_cat_label'].lower()} {d['rain_mm']:g} mm, "
               f"chance {d['chance']}%, gusts {d['gust_kmh']:.0f} km/h, max {d['tmax']:.0f} C. "
               f"{view['district']}, {view['state']}. {WX_LABEL[sev]}.")
        if note:
            msg += f" Note: {note}"
        if existing and existing["severity"] == sev:
            self.repo.update_warning(existing["id"], title=title, message=msg)
            return existing["id"]
        if existing:
            self.repo.clear_warning(existing["id"])
        return self.repo.add_warning("area", aid, sev, title, msg, "auto")

    def _sync_auto_warning(self, view, note=""):
        ttype = view["kind"]
        existing = self.repo.active_auto_warning(ttype, view["id"])
        sev = view["status"]
        if sev == "normal":
            if existing:
                self.repo.clear_warning(existing["id"])
            return None
        if ttype == "station":
            title = f"{LABEL[sev]} flood situation - {view['name']} ({view['river']})"
            msg = (f"Level {view['current_level']:.2f} m (WL {view['warning_level']:.2f}, DL {view['danger_level']:.2f}, "
                   f"HFL {view['hfl']:.2f}). Forecast {view['forecast_level']:.2f} m, trend {view['trend']}. "
                   f"{view['district']}, {view['state']}.")
        else:
            title = f"{view['status_label']} - {view['name']}"
            msg = (f"Level {view['current_level']:.2f} m vs FRL {view['frl']:.2f} m, approx. {view['storage_pct']:.0f}% live storage. "
                   f"Inflow {view['inflow_cumecs']:.0f} / outflow {view['outflow_cumecs']:.0f} cumecs. "
                   f"Downstream areas of {view['district']}, {view['state']} to stay alert.")
        if note:
            msg += f" Note: {note}"
        if existing and existing["severity"] == sev:
            self.repo.update_warning(existing["id"], title=title, message=msg)
            return existing["id"]
        if existing:
            self.repo.clear_warning(existing["id"])
        return self.repo.add_warning(ttype, view["id"], sev, title, msg, "auto")

    def _sync_all_auto_warnings(self):
        for s in self.repo.stations():
            self._sync_auto_warning(self.station_view(s))
        for r in self.repo.reservoirs():
            self._sync_auto_warning(self.reservoir_view(r))
        for a in self.repo.areas():
            self._sync_area_warning(a["id"])
