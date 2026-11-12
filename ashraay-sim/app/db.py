"""Data layer (repository): SQLite schema, seeding and raw queries.

Only this module talks SQL. The service layer (services.py) holds the rules.
"""
import json
import math
import random
import re
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone

from . import config
from .seed_data import (LEVEL_STATIONS, RESERVOIRS, WARDS, STATE_CLIMATE, DEFAULT_CLIMATE)

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY, name TEXT, river TEXT, basin TEXT, state TEXT, district TEXT,
    lat REAL, lon REAL, warning_level REAL, danger_level REAL, hfl REAL,
    current_level REAL, forecast_level REAL, forecast_for TEXT, trend TEXT,
    updated_at TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS reservoirs (
    id TEXT PRIMARY KEY, name TEXT, river TEXT, basin TEXT, state TEXT, district TEXT,
    lat REAL, lon REAL, frl REAL, mddl REAL, live_capacity_mcm REAL,
    current_level REAL, inflow_cumecs REAL, outflow_cumecs REAL,
    updated_at TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id TEXT, ts TEXT, level REAL
);
CREATE INDEX IF NOT EXISTS ix_obs ON observations(target_type, target_id, ts);
CREATE TABLE IF NOT EXISTS areas (
    id TEXT PRIMARY KEY, name TEXT, kind TEXT, district TEXT, state TEXT, lat REAL, lon REAL
);
CREATE TABLE IF NOT EXISTS forecast (
    area_id TEXT, day_idx INTEGER, date TEXT, rain_mm REAL, chance INTEGER, tmax REAL, tmin REAL,
    humidity INTEGER, wind_kmh REAL, gust_kmh REAL, source TEXT, updated_at TEXT,
    PRIMARY KEY (area_id, day_idx)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id TEXT,
    severity TEXT, title TEXT, message TEXT, origin TEXT, active INTEGER,
    created_at TEXT, cleared_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, action TEXT, target_type TEXT,
    target_id TEXT, detail TEXT, client TEXT
);
CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, change TEXT, level TEXT, kind TEXT,
    target_id TEXT, name TEXT, place TEXT, detail TEXT
);
"""

STORAGE_EXP = 1.6   # simple area-capacity approximation: storage ~ depth^1.6


def now_iso(dt=None):
    return (dt or datetime.now(timezone.utc)).replace(microsecond=0).isoformat()


def today():
    return date.today()


def slug(*parts):
    return re.sub(r"[^A-Za-z0-9]+", "-", "-".join(parts)).strip("-").upper()


def level_for_fill(frl, mddl, pct):
    frac = max(0.0, pct / 100.0) ** (1 / STORAGE_EXP)
    return round(mddl + (frl - mddl) * frac, 2)


def gen_district_rain(state, district, d, rnd):
    """District-level daily rain (mm) so wards in one district are correlated."""
    p, mean, _ = STATE_CLIMATE.get(state, DEFAULT_CLIMATE)
    r = random.Random(f"{state}|{district}|{d.isoformat()}|{rnd}")
    return r.expovariate(1 / mean) if r.random() < p else 0.0


def gen_day(area_id, state, district, d, seed=42):
    """Generate one plausible day of weather for an area (deterministic per area+date)."""
    _, _, tbase = STATE_CLIMATE.get(state, DEFAULT_CLIMATE)
    r = random.Random(f"{area_id}|{d.isoformat()}|{seed}")
    base = gen_district_rain(state, district, d, seed)
    rain = round(base * r.uniform(0.6, 1.4), 1) if base else 0.0
    if rain < 0.3:
        rain = 0.0
    chance = int(min(98, max(3, (35 if rain else 5) + rain * 1.1 + r.uniform(-6, 12))))
    tmax = round(tbase - min(rain, 120) / 25 + r.uniform(-1.5, 1.5), 1)
    tmin = round(tmax - r.uniform(7, 11), 1)
    hum = int(min(98, 45 + rain / 2 + r.uniform(0, 18)))
    wind = round(r.uniform(6, 22), 0)
    gust = round(wind * 1.5 + rain / 8, 0)
    return dict(rain_mm=rain, chance=chance, tmax=tmax, tmin=tmin, humidity=hum, wind_kmh=wind, gust_kmh=gust)


class Repository:
    def __init__(self, path=None):
        self.path = str(path or config.DB_PATH)
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._con = sqlite3.connect(self.path, check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        with self._lock:
            self._con.executescript(SCHEMA)
            self._con.commit()
        if not self.count("stations") or not self.count("areas"):
            self.seed()

    # ---------- helpers ----------
    def _q(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self._con.execute(sql, args).fetchall()]

    def _x(self, sql, args=()):
        with self._lock:
            cur = self._con.execute(sql, args)
            self._con.commit()
            return cur.lastrowid

    def count(self, table):
        return self._q(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"]

    def get_meta(self, k, default=None):
        r = self._q("SELECT v FROM meta WHERE k=?", (k,))
        return r[0]["v"] if r else default

    def set_meta(self, k, v):
        self._x("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))

    # ---------- seeding ----------
    def seed(self):
        rnd = random.Random(42)
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        with self._lock:
            c = self._con
            for t in ("stations", "reservoirs", "observations", "warnings", "audit", "areas", "forecast", "meta"):
                c.execute(f"DELETE FROM {t}")
            for (sid, name, river, basin, state, dist, lat, lon, wl, dl, hfl, s) in LEVEL_STATIONS:
                if s == "N":
                    cur = wl - rnd.uniform(0.4, 2.5); trend = rnd.choice(["steady", "falling", "rising"])
                elif s == "A":
                    cur = wl + (dl - wl) * rnd.uniform(0.25, 0.85); trend = "rising"
                elif s == "S":
                    cur = dl + (hfl - dl) * rnd.uniform(0.15, 0.55); trend = "rising"
                else:
                    cur = hfl + rnd.uniform(0.05, 0.30); trend = "rising"
                cur = round(cur, 2)
                rate = {"rising": 0.04, "falling": -0.03, "steady": 0.0}[trend]
                fc = {"N": cur + rate * 12, "A": cur + (dl - cur) * 0.5,
                      "S": cur + (hfl - cur) * 0.4, "E": cur + 0.1}[s]
                c.execute("INSERT INTO stations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (sid, name, river, basin, state, dist, lat, lon, wl, dl, hfl, cur, round(fc, 2),
                           now_iso(now + timedelta(hours=12)), trend, now_iso(now), "seed"))
                for h in range(config.HISTORY_HOURS, -1, -1):
                    lvl = cur - rate * h + math.sin(h / 5.0) * 0.03 + rnd.uniform(-0.02, 0.02)
                    c.execute("INSERT INTO observations(target_type,target_id,ts,level) VALUES ('station',?,?,?)",
                              (sid, now_iso(now - timedelta(hours=h)), round(lvl if h else cur, 2)))
            for (rid, name, river, basin, state, dist, lat, lon, frl, mddl, cap, pct) in RESERVOIRS:
                cur = level_for_fill(frl, mddl, pct)
                inflow = round(cap * rnd.uniform(0.02, 0.09), 0)
                outflow = round(inflow * rnd.uniform(0.4, 1.1), 0)
                c.execute("INSERT INTO reservoirs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (rid, name, river, basin, state, dist, lat, lon, frl, mddl, cap, cur,
                           inflow, outflow, now_iso(now), "seed"))
                start = level_for_fill(frl, mddl, max(0, pct - rnd.uniform(1, 4)))
                for h in range(config.HISTORY_HOURS, -1, -1):
                    lvl = cur - (cur - start) * h / config.HISTORY_HOURS
                    c.execute("INSERT INTO observations(target_type,target_id,ts,level) VALUES ('reservoir',?,?,?)",
                              (rid, now_iso(now - timedelta(hours=h)), round(lvl, 2)))
            # ---- weather areas: curated wards + one HQ point for every other district ----
            areas = []
            for (state, dist), wards in WARDS.items():
                for (wname, lat, lon) in wards:
                    areas.append((slug("W", dist, wname), wname, "ward", dist, state, lat, lon))
            pts = {}
            for row in LEVEL_STATIONS:
                pts.setdefault((row[4], row[5]), []).append((row[6], row[7]))
            for row in RESERVOIRS:
                pts.setdefault((row[4], row[5]), []).append((row[6], row[7]))
            for (state, dist), ll in sorted(pts.items()):
                if (state, dist) in WARDS:
                    continue
                lat = sum(p[0] for p in ll) / len(ll); lon = sum(p[1] for p in ll) / len(ll)
                areas.append((slug("D", state, dist), f"{dist} (district HQ)", "district_hq", dist, state,
                              round(lat, 3), round(lon, 3)))
            c.executemany("INSERT INTO areas VALUES (?,?,?,?,?,?,?)", areas)
            t0 = today()
            for (aid, _, _, dist, state, _, _) in areas:
                for i in range(config.FORECAST_DAYS):
                    d = t0 + timedelta(days=i)
                    g = gen_day(aid, state, dist, d)
                    c.execute("INSERT INTO forecast VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                              (aid, i, d.isoformat(), g["rain_mm"], g["chance"], g["tmax"], g["tmin"],
                               g["humidity"], g["wind_kmh"], g["gust_kmh"], "seed", now_iso()))
            c.execute("INSERT INTO meta(k,v) VALUES('forecast_base', ?)", (t0.isoformat(),))
            c.commit()

    def roll_forecast(self, t0=None):
        """If the calendar day changed since the forecast was made, shift days and generate new ones."""
        t0 = t0 or today()
        base = self.get_meta("forecast_base")
        if base == t0.isoformat():
            return False
        shift = (t0 - date.fromisoformat(base)).days if base else config.FORECAST_DAYS
        n = config.FORECAST_DAYS
        with self._lock:
            c = self._con
            if shift > 0:
                c.execute("DELETE FROM forecast WHERE day_idx < ?", (min(shift, n),))
                c.execute("UPDATE forecast SET day_idx = day_idx - ?", (shift,))
            areas = [dict(r) for r in c.execute("SELECT * FROM areas").fetchall()]
            for a in areas:
                have = {r[0] for r in c.execute("SELECT day_idx FROM forecast WHERE area_id=?", (a["id"],))}
                for i in range(n):
                    d = t0 + timedelta(days=i)
                    if i in have:
                        c.execute("UPDATE forecast SET date=? WHERE area_id=? AND day_idx=?", (d.isoformat(), a["id"], i))
                        continue
                    g = gen_day(a["id"], a["state"], a["district"], d)
                    c.execute("INSERT INTO forecast VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                              (a["id"], i, d.isoformat(), g["rain_mm"], g["chance"], g["tmax"], g["tmin"],
                               g["humidity"], g["wind_kmh"], g["gust_kmh"], "seed", now_iso()))
            c.execute("DELETE FROM forecast WHERE day_idx < 0 OR day_idx >= ?", (n,))
            c.execute("INSERT INTO meta(k,v) VALUES('forecast_base',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      (t0.isoformat(),))
            c.commit()
        return True

    # ---------- reads ----------
    def stations(self):
        return self._q("SELECT * FROM stations ORDER BY state, river, name")

    def station(self, sid):
        r = self._q("SELECT * FROM stations WHERE id=?", (sid,))
        return r[0] if r else None

    def reservoirs(self):
        return self._q("SELECT * FROM reservoirs ORDER BY state, district, name")

    def reservoir(self, rid):
        r = self._q("SELECT * FROM reservoirs WHERE id=?", (rid,))
        return r[0] if r else None

    def areas(self):
        return self._q("SELECT * FROM areas ORDER BY state, district, kind DESC, name")

    def area(self, aid):
        r = self._q("SELECT * FROM areas WHERE id=?", (aid,))
        return r[0] if r else None

    def forecast_all(self):
        return self._q("SELECT * FROM forecast ORDER BY area_id, day_idx")

    def forecast_for(self, aid):
        return self._q("SELECT * FROM forecast WHERE area_id=? ORDER BY day_idx", (aid,))

    def history(self, ttype, tid, limit=200):
        rows = self._q("SELECT ts, level FROM observations WHERE target_type=? AND target_id=? "
                       "ORDER BY ts DESC, id DESC LIMIT ?", (ttype, tid, limit))
        return list(reversed(rows))

    def warnings(self, active_only=True):
        sql = "SELECT * FROM warnings" + (" WHERE active=1" if active_only else "") + \
              " ORDER BY created_at DESC, id DESC LIMIT 400"
        return self._q(sql)

    def active_auto_warning(self, ttype, tid):
        r = self._q("SELECT * FROM warnings WHERE active=1 AND origin='auto' AND target_type=? AND target_id=?",
                    (ttype, tid))
        return r[0] if r else None

    def audit(self, limit=100):
        rows = self._q("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["detail"] = json.loads(r["detail"] or "{}")
        return rows

    def monitor_events(self, limit=300):
        rows = self._q("SELECT * FROM monitor_events ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["detail"] = json.loads(r["detail"] or "{}")
        return rows

    # ---------- writes ----------
    def update_station(self, sid, **f):
        cols = ", ".join(f"{k}=?" for k in f)
        self._x(f"UPDATE stations SET {cols} WHERE id=?", (*f.values(), sid))

    def update_reservoir(self, rid, **f):
        cols = ", ".join(f"{k}=?" for k in f)
        self._x(f"UPDATE reservoirs SET {cols} WHERE id=?", (*f.values(), rid))

    def update_forecast(self, aid, day_idx, **f):
        cols = ", ".join(f"{k}=?" for k in f)
        self._x(f"UPDATE forecast SET {cols} WHERE area_id=? AND day_idx=?", (*f.values(), aid, day_idx))

    def add_observation(self, ttype, tid, ts, level):
        self._x("INSERT INTO observations(target_type,target_id,ts,level) VALUES (?,?,?,?)", (ttype, tid, ts, level))

    def add_warning(self, ttype, tid, severity, title, message, origin):
        return self._x("INSERT INTO warnings(target_type,target_id,severity,title,message,origin,active,created_at) "
                       "VALUES (?,?,?,?,?,?,1,?)", (ttype, tid, severity, title, message, origin, now_iso()))

    def update_warning(self, wid, **f):
        cols = ", ".join(f"{k}=?" for k in f)
        self._x(f"UPDATE warnings SET {cols} WHERE id=?", (*f.values(), wid))

    def clear_warning(self, wid):
        self._x("UPDATE warnings SET active=0, cleared_at=? WHERE id=? AND active=1", (now_iso(), wid))

    def add_audit(self, action, ttype, tid, detail, client):
        self._x("INSERT INTO audit(ts,action,target_type,target_id,detail,client) VALUES (?,?,?,?,?,?)",
                (now_iso(), action, ttype, tid, json.dumps(detail), client))

    def add_monitor_event(self, e):
        return self._x("INSERT INTO monitor_events(ts,change,level,kind,target_id,name,place,detail) VALUES (?,?,?,?,?,?,?,?)",
                       (e.get("ts") or now_iso(), e["change"], e["level"], e["kind"], e["target_id"],
                        e["name"], e.get("place", ""), json.dumps(e.get("detail") or {})))

    def clear_monitor_events(self):
        self._x("DELETE FROM monitor_events")
