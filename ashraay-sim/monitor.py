#!/usr/bin/env python3
"""ASHRAAY Watch - monitoring script for the Hazard Simulator.

What it does (rules only - it is the "watcher", not an AI agent):
  * listens to the server's live feed (/api/stream); falls back to polling if the feed drops
  * on every change reads /api/snapshot and works out the current alerts:
        rain / wind / heat forecasts  Orange (HIGH) and Red (EXTREME) per ward or district, next 5 days
        river stations                Severe (HIGH) and Extreme (EXTREME)
        dams / reservoirs             >=90% (HIGH) and at/above FRL (EXTREME)
        manual warnings               every active one
  * reports only CHANGES: NEW, UPGRADED, UPDATED, DOWNGRADED, CLEARED
  * writes them to the console, logs/monitor.log (text) and logs/alerts.jsonl (one JSON per line)
  * sends them to the server so they appear on the dashboard's "Monitor" page

Run:  python monitor.py                      (or double-click monitor.bat)
      python monitor.py --url http://192.168.1.25:8080 --include-yellow
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
RANK = {"normal": 0, "above_normal": 1, "severe": 2, "extreme": 3}
LEVEL = {"above_normal": "WATCH", "severe": "HIGH", "extreme": "EXTREME"}
WX = {"above_normal": "Yellow", "severe": "Orange", "extreme": "Red"}
COLORS = {"EXTREME": "\033[91m", "HIGH": "\033[93m", "WATCH": "\033[96m", "CLEARED": "\033[92m", "END": "\033[0m"}
# Bypass any system proxy: the simulator is on this PC or the local network.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Watch:
    def __init__(self, url, token="", include_yellow=False, color=True, report=True, log_dir=None):
        self.url = url.rstrip("/")
        self.token = token
        self.min_rank = 1 if include_yellow else 2
        self.color = color
        self.report = report
        self.log_dir = log_dir or os.path.join(HERE, "logs")
        os.makedirs(self.log_dir, exist_ok=True)
        self.text_log = os.path.join(self.log_dir, "monitor.log")
        self.json_log = os.path.join(self.log_dir, "alerts.jsonl")
        self.state = {}
        self.started = datetime.now().isoformat(timespec="seconds")
        self.stop = threading.Event()
        self.connected = False
        self.dates = []

    # ---------------- http ----------------
    def _req(self, path, body=None, timeout=10):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method="POST" if body is not None else "GET",
                                     headers={"Content-Type": "application/json", "X-Sim-Token": self.token})
        return OPENER.open(req, timeout=timeout)

    def get(self, path):
        with self._req(path) as r:
            return json.loads(r.read())

    def post(self, path, body):
        try:
            with self._req(path, body, timeout=5) as r:
                return json.loads(r.read())
        except Exception:
            return None

    # ---------------- logic ----------------
    def alerts(self, snap):
        """Turn a snapshot into {key: alert}. Only items at or above the chosen level."""
        out = {}
        self.dates = snap.get("dates", [])
        for s in snap["stations"]:
            if RANK[s["status"]] >= self.min_rank:
                out["river:" + s["id"]] = dict(
                    kind="river", target_id=s["id"], name=f"{s['name']} ({s['river']})", status=s["status"],
                    place=f"{s['district']}, {s['state']}",
                    summary=f"level {s['current_level']:.2f} m, forecast {s['forecast_level']:.2f} m (danger {s['danger_level']:.2f}, HFL {s['hfl']:.2f})",
                    detail={"level_m": s["current_level"], "forecast_m": s["forecast_level"], "danger_m": s["danger_level"],
                            "hfl_m": s["hfl"], "trend": s["trend"], "source": s["source"], "updated_at": s["updated_at"]})
        for r in snap["reservoirs"]:
            if RANK[r["status"]] >= self.min_rank:
                out["dam:" + r["id"]] = dict(
                    kind="dam", target_id=r["id"], name=r["name"], status=r["status"], place=f"{r['district']}, {r['state']}",
                    summary=f"{r['current_level']:.2f} m, {r['storage_pct']:.0f}% full (FRL {r['frl']:.2f}), inflow {r['inflow_cumecs']:.0f} cumecs",
                    detail={"level_m": r["current_level"], "frl_m": r["frl"], "storage_pct": r["storage_pct"],
                            "inflow_cumecs": r["inflow_cumecs"], "outflow_cumecs": r["outflow_cumecs"], "source": r["source"]})
        for a in snap["areas"]:
            if RANK[a["status"]] < self.min_rank:
                continue
            bad = [(i, d) for i, d in enumerate(a["days"]) if RANK[d["status"]] >= self.min_rank]
            i, d = max(bad, key=lambda x: (RANK[x[1]["status"]], x[1]["rain_mm"]))
            when = self.dates[i]["label"] if i < len(self.dates) else f"day {i + 1}"
            reasons = ", ".join(d.get("reasons") or []) or "warning"
            days = ", ".join(f"{self.dates[j]['label'] if j < len(self.dates) else j + 1}: {x['rain_mm']:g} mm {WX.get(x['status'], 'Green')}"
                             for j, x in bad)
            nm = a["name"] if a["area_kind"] == "ward" else a["district"]
            out["rain:" + a["id"]] = dict(
                kind="rain", target_id=a["id"], name=nm, status=a["status"], place=f"{a['district']}, {a['state']}",
                summary=f"{WX[a['status']]} - {reasons} {when}" + (f" (also {len(bad) - 1} more day(s))" if len(bad) > 1 else ""),
                detail={"peak_day": when, "peak_date": self.dates[i]["date"] if i < len(self.dates) else None,
                        "rain_mm": d["rain_mm"], "gust_kmh": d["gust_kmh"], "tmax": d["tmax"], "days": days,
                        "source": a["source"]})
        for w in snap["warnings"]:
            if w["origin"] == "manual":
                out["warning:" + str(w["id"])] = dict(
                    kind="warning", target_id=str(w["id"]), name=w["title"], status=w["severity"],
                    place=(f"{w['target_type']} {w['target_id']}" if w["target_id"] else "General area"),
                    summary=w["message"][:160], detail={"warning_id": w["id"], "message": w["message"]})
        return out

    def diff(self, old, new):
        for k, a in new.items():
            if k not in old:
                yield "NEW", a
            elif RANK[a["status"]] > RANK[old[k]["status"]]:
                yield "UPGRADED", a
            elif RANK[a["status"]] < RANK[old[k]["status"]]:
                yield "DOWNGRADED", a
            elif a["summary"] != old[k]["summary"]:
                yield "UPDATED", a
        for k, a in old.items():
            if k not in new:
                yield "CLEARED", a

    # ---------------- output ----------------
    def emit(self, events):
        if not events:
            return
        ts = datetime.now().isoformat(timespec="seconds")
        recs = []
        for change, a in events:
            level = "CLEARED" if change == "CLEARED" else LEVEL[a["status"]]
            rec = {"ts": ts, "change": change, "level": level, "kind": a["kind"], "target_id": a["target_id"],
                   "name": a["name"], "place": a["place"], "summary": a["summary"], "detail": a["detail"]}
            recs.append(rec)
            kind = {"rain": "RAIN ", "river": "RIVER", "dam": "DAM  ", "warning": "WARN "}[a["kind"]]
            line = f"[{ts.replace('T', ' ')}] {change:<15} {level:<8} {kind} {a['name']} ({a['place']}) - {a['summary']}"
            c = COLORS.get(level, "") if self.color else ""
            print(f"{c}{line}{COLORS['END'] if c else ''}", flush=True)
            with open(self.text_log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        with open(self.json_log, "a", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
        if self.report:
            for i in range(0, len(recs), 100):
                self.post("/api/monitor/report", {"events": [dict(r, detail={**r["detail"], "summary": r["summary"]}) for r in recs[i:i + 100]]})

    def info(self, msg):
        line = f"[{datetime.now().isoformat(timespec='seconds').replace('T', ' ')}] {msg}"
        print(line, flush=True)
        with open(self.text_log, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def check(self, first=False):
        new = self.alerts(self.get("/api/snapshot"))
        if first:
            order = sorted(new.values(), key=lambda a: (-RANK[a["status"]], a["kind"], a["name"]))
            self.emit([("ACTIVE_AT_START", a) for a in order])
        else:
            self.emit(list(self.diff(self.state, new)))
        self.state = new

    # ---------------- loops ----------------
    def heartbeat_loop(self):
        while not self.stop.is_set():
            if self.report:
                self.post("/api/monitor/heartbeat", {"host": socket.gethostname(), "pid": os.getpid(),
                                                      "started_at": self.started, "watching": len(self.state),
                                                      "min_level": "WATCH" if self.min_rank == 1 else "HIGH",
                                                      "log_file": self.json_log})
            self.stop.wait(10)

    def wait_for_server(self):
        shown = False
        while not self.stop.is_set():
            try:
                self.get("/api/health")
                return
            except Exception:
                if not shown:
                    self.info(f"Waiting for {self.url} ... (is the simulator running? double-click start.bat)")
                    shown = True
                time.sleep(3)

    def run(self):
        self.info(f"ASHRAAY Watch started - monitoring {self.url} "
                  f"(levels: {'WATCH, ' if self.min_rank == 1 else ''}HIGH, EXTREME)")
        self.info(f"Logs: {self.text_log}  and  {self.json_log}")
        self.wait_for_server()
        self.check(first=True)
        self.info(f"Connected. {len(self.state)} alert(s) active now. Waiting for changes ... (Ctrl+C to stop)")
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        fails = 0
        while not self.stop.is_set():
            try:
                with self._req("/api/stream", timeout=45) as s:
                    if fails:
                        self.info("Live feed reconnected.")
                        self.check()
                    fails = 0
                    for raw in s:
                        if raw.startswith(b"data:") and b'"kind"' in raw:
                            evt = json.loads(raw[5:])
                            if evt.get("kind") == "monitor":
                                continue            # our own reports - nothing changed in the data
                            self.check()
            except KeyboardInterrupt:
                raise
            except Exception as e:
                fails += 1
                if fails == 1:
                    self.info(f"Live feed lost ({e.__class__.__name__}); polling every 10 s until it is back.")
                try:
                    self.check()
                except Exception:
                    if fails in (1, 3) or fails % 30 == 0:
                        self.info("SOURCE UNREACHABLE - alerts shown above may be out of date.")
                self.stop.wait(10)


def main():
    if os.name == "nt":
        os.system("")   # enables colour codes in the Windows console
    try:
        sys.stdout.reconfigure(line_buffering=True, errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="ASHRAAY Watch - monitor the Hazard Simulator for alerts")
    ap.add_argument("--url", default=os.environ.get("ASHRAAY_URL", "http://localhost:8080"))
    ap.add_argument("--token", default=os.environ.get("FFS_SIM_TOKEN", ""), help="only if the server sets FFS_SIM_TOKEN")
    ap.add_argument("--include-yellow", action="store_true", help="also report WATCH level (Yellow / Above Normal)")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--no-report", action="store_true", help="don't send alerts to the dashboard's Monitor page")
    a = ap.parse_args()
    w = Watch(a.url, a.token, a.include_yellow, not a.no_color, not a.no_report)
    try:
        w.run()
    except KeyboardInterrupt:
        w.stop.set()
        print("\nStopped.")


if __name__ == "__main__":
    main()
