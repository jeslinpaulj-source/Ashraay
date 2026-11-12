"""Backend + monitor tests (standard library only):   python -m unittest discover -s tests -v"""
import json, os, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from datetime import date, timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="ashraay-test-")
os.environ["FFS_DATA_DIR"] = TMP
from app import config  # noqa: E402
config.DATA_DIR = Path(TMP); config.DB_PATH = config.DATA_DIR / "test.db"
from app.http import make_server  # noqa: E402
import monitor  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BELL = "W-BENGALURU-URBAN-BELLANDUR"


def call(base, path, body=None):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with OPENER.open(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


class API(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = make_server("127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        call(self.base, "/api/sim/reset", {})

    def test_pages_and_static(self):
        for p in ("/", "/weather", "/simulate", "/reservoir", "/monitor", "/assets/js/app.js", "/assets/geo/basemap.json", "/favicon.ico"):
            with OPENER.open(self.base + p) as r:
                self.assertEqual(r.status, 200, p)
        self.assertEqual(call(self.base, "/assets/../app/config.py")[0], 404)
        self.assertEqual(call(self.base, "/api/nope")[0], 404)

    def test_snapshot_shape(self):
        c, s = call(self.base, "/api/snapshot")
        self.assertEqual(c, 200)
        self.assertEqual(len(s["dates"]), 5)
        self.assertEqual(s["dates"][0]["date"], date.today().isoformat())
        self.assertGreater(len(s["areas"]), 150)
        self.assertGreater(len(s["stations"]), 70)
        self.assertGreater(len(s["reservoirs"]), 45)
        a = next(x for x in s["areas"] if x["id"] == BELL)
        self.assertEqual((a["state"], a["district"], a["area_kind"]), ("Karnataka", "Bengaluru Urban", "ward"))
        self.assertEqual(len(a["days"]), 5)

    def test_meta_trees(self):
        m = call(self.base, "/api/meta")[1]
        self.assertIn("Bellandur", [w["name"] for w in m["weather_tree"]["Karnataka"]["Bengaluru Urban"]])
        self.assertIn("RSV-KRS", [d["id"] for d in m["reservoir_tree"]["Karnataka"]["Mandya"]])

    def test_rain_ward_cm_and_categories(self):
        c, r = call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 15, "unit": "cm"})
        self.assertEqual(c, 200, r)
        self.assertEqual(r["rain_mm"], 150.0)
        self.assertEqual(r["rain_cat_label"], "Very heavy rain")
        self.assertEqual(r["area"]["days"][1]["status"], "severe")
        ws = [w for w in call(self.base, "/api/warnings")[1] if w["target_id"] == BELL]
        self.assertEqual(len(ws), 1); self.assertEqual(ws[0]["severity"], "severe")
        for mm, cat, st in [(64.5, "heavy", "above_normal"), (115.6, "very_heavy", "severe"), (204.5, "extremely_heavy", "extreme"), (0, "no_rain", "normal")]:
            r = call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": mm})[1]
            self.assertEqual((r["area"]["days"][1]["rain_cat"], r["area"]["days"][1]["status"]), (cat, st), mm)
        self.assertFalse([w for w in call(self.base, "/api/warnings")[1] if w["target_id"] == BELL and w["origin"] == "auto"])

    def test_rain_district_state_and_propagation(self):
        before = call(self.base, "/api/reservoirs/RSV-HSG")[1]["inflow_cumecs"]
        c, r = call(self.base, "/api/sim/rain", {"scope": "district", "state": "Karnataka", "district": "Bengaluru Urban", "day": 2, "rain": 250, "propagate": True})
        self.assertEqual(c, 200, r); self.assertEqual(len(r["areas"]), 21); self.assertIn("RSV-HSG", r["impacted"])
        self.assertGreater(call(self.base, "/api/reservoirs/RSV-HSG")[1]["inflow_cumecs"], before)
        st = call(self.base, "/api/snapshot")[1]
        self.assertEqual(sum(1 for a in st["areas"] if a["district"] == "Bengaluru Urban" and a["days"][2]["status"] == "extreme"), 21)
        fc0 = call(self.base, "/api/stations/GNG-PTN")[1]["forecast_level"]
        call(self.base, "/api/sim/rain", {"scope": "state", "state": "Bihar", "day": 0, "rain": 200, "propagate": True})
        self.assertGreater(call(self.base, "/api/stations/GNG-PTN")[1]["forecast_level"], fc0)

    def test_wind_and_heat_raise_colour(self):
        r = call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 0, "rain": 0, "gust_kmh": 95})[1]
        self.assertEqual(r["area"]["days"][0]["status"], "extreme")
        r = call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 0, "rain": 0, "gust_kmh": 10, "tmax": 45.5})[1]
        self.assertEqual(r["area"]["days"][0]["status"], "severe")

    def test_rain_validation(self):
        for body, code in [({"scope": "ward", "area_id": BELL, "day": 1, "rain": -1}, 400),
                           ({"scope": "ward", "area_id": BELL, "day": 9, "rain": 10}, 400),
                           ({"scope": "ward", "area_id": BELL, "day": 1, "rain": "abc"}, 400),
                           ({"scope": "ward", "area_id": BELL, "day": 1, "rain": 10, "unit": "inch"}, 400),
                           ({"scope": "ward", "area_id": "NOPE", "day": 1, "rain": 10}, 404),
                           ({"scope": "district", "state": "Karnataka", "district": "Nowhere", "day": 1, "rain": 10}, 404),
                           ({"scope": "galaxy", "state": "Karnataka", "day": 1, "rain": 10}, 400)]:
            self.assertEqual(call(self.base, "/api/sim/rain", body)[0], code, body)

    def test_station_reservoir_scenario_warning(self):
        s = call(self.base, "/api/stations/GNG-VNS")[1]
        self.assertEqual(call(self.base, "/api/sim/station/GNG-VNS", {"level": s["hfl"] + 0.2})[1]["station"]["status"], "extreme")
        self.assertEqual(call(self.base, "/api/sim/station/GNG-VNS", {"level": 99999})[0], 400)
        r = call(self.base, "/api/sim/reservoir/RSV-KRS", {"level": 752.9, "inflow_cumecs": 2500})[1]
        self.assertEqual(r["reservoir"]["status"], "extreme"); self.assertIsNotNone(r["warning"])
        self.assertEqual(call(self.base, "/api/reservoirs/RSV-KRS")[1]["history"][-1]["level"], 752.9)
        self.assertGreater(len(call(self.base, "/api/sim/scenario", {"basin": "Godavari", "delta_m": 2})[1]["changed"]), 2)
        c, w = call(self.base, "/api/sim/warnings", {"severity": "extreme", "target_type": "area", "target_id": BELL, "title": "Flood", "message": "Move"})
        self.assertEqual(c, 200)
        call(self.base, f"/api/sim/warnings/{w['id']}/clear", {})
        self.assertNotIn(w["id"], [x["id"] for x in call(self.base, "/api/warnings")[1]])

    def test_sse_event_on_change(self):
        got = []
        def listen():
            with OPENER.open(self.base + "/api/stream", timeout=15) as r:
                for line in r:
                    if line.startswith(b"data:") and b'"kind"' in line:
                        got.append(json.loads(line[5:])); return
        t = threading.Thread(target=listen, daemon=True); t.start(); time.sleep(0.5)
        call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 150})
        t.join(5)
        self.assertTrue(got and got[0]["kind"] == "weather", got)

    def test_reset_restores_seed_levels_and_removes_custom_warnings(self):
        seed_area = call(self.base, f"/api/weather/{BELL}")[1]
        seed_station = call(self.base, "/api/stations/GNG-VNS")[1]
        seed_dam = call(self.base, "/api/reservoirs/RSV-KRS")[1]
        call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 250})
        call(self.base, "/api/sim/station/GNG-VNS", {"level": seed_station["hfl"] + 0.2})
        call(self.base, "/api/sim/reservoir/RSV-KRS", {"level": seed_dam["frl"] + 0.2})
        call(self.base, "/api/sim/warnings", {
            "severity": "extreme", "target_type": "area", "target_id": BELL,
            "title": "Reset test warning", "message": "Demo only",
        })
        code, result = call(self.base, "/api/sim/reset", {})
        self.assertEqual((code, result), (200, {"reset": True}))
        self.assertEqual(call(self.base, f"/api/weather/{BELL}")[1]["days"], seed_area["days"])
        self.assertEqual(call(self.base, "/api/stations/GNG-VNS")[1]["current_level"], seed_station["current_level"])
        self.assertEqual(call(self.base, "/api/reservoirs/RSV-KRS")[1]["current_level"], seed_dam["current_level"])
        warnings = call(self.base, "/api/warnings")[1]
        self.assertFalse(any(w["title"] == "Reset test warning" for w in warnings))
        self.assertTrue(any(w["severity"] in ("severe", "extreme") for w in warnings))

    def test_forecast_rollover(self):
        from app import http as h
        repo = h.service.repo
        repo.set_meta("forecast_base", (date.today() - timedelta(days=2)).isoformat())
        old = repo.forecast_for(BELL)
        self.assertTrue(repo.roll_forecast())
        new = repo.forecast_for(BELL)
        self.assertEqual(len(new), 5)
        self.assertEqual(new[0]["date"], date.today().isoformat())
        self.assertEqual(new[0]["rain_mm"], old[2]["rain_mm"])      # day 3 became today

    def test_monitor_end_to_end(self):
        logs = tempfile.mkdtemp(prefix="mon-")
        w = monitor.Watch(self.base, log_dir=logs, color=False)
        th = threading.Thread(target=w.run, daemon=True); th.start()
        time.sleep(2.5)
        call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 15, "unit": "cm"})
        time.sleep(1.5)
        call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 25, "unit": "cm"})
        time.sleep(1.5)
        call(self.base, "/api/sim/rain", {"scope": "ward", "area_id": BELL, "day": 1, "rain": 0})
        time.sleep(1.5)
        w.stop.set()
        lines = [json.loads(x) for x in open(os.path.join(logs, "alerts.jsonl"), encoding="utf-8")]
        bell = [(x["change"], x["level"]) for x in lines if x["target_id"] == BELL]
        self.assertEqual(bell, [("NEW", "HIGH"), ("UPGRADED", "EXTREME"), ("CLEARED", "CLEARED")], bell)
        self.assertTrue(open(os.path.join(logs, "monitor.log"), encoding="utf-8").read())
        m = call(self.base, "/api/monitor")[1]
        self.assertTrue(m["status"]["online"])
        self.assertIn("Bellandur", [e["name"] for e in m["events"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
