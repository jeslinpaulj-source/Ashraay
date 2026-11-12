# ASHRAAY Hazard Simulator — weather · rivers · dams · monitor

One local web app with:

- **Weather forecasts**: 2-day and 5-day views, organised as state → district → ward.
- **River flood levels** and **dam / reservoir levels**.
- **One simulator** to inject scenarios (e.g. *15 cm rain tomorrow in Bellandur*).
- **A monitor (watch) script** that logs every High / Extreme alert.

Every open page updates live, with no reload.

> **Simulation only.** Place, river and dam names are real. Every forecast, level and threshold is **generated or approximate seed data**. It is **not** an official IMD, CWC or state forecast. Don't use it to publish real warnings.

## 1. Run it (no installs)

You need only **Python 3.9 or newer**; no pip install.

| Step | Windows | macOS / Linux |
|---|---|---|
| Start the simulator | double-click **`start.bat`** (opens the browser) | `./start.sh` |
| Start the monitor | double-click **`monitor.bat`** | `./monitor.sh` |

The server console prints the links:

```
Dashboard         http://localhost:8080/
Weather forecast  http://localhost:8080/#/weather
Rivers & dams     http://localhost:8080/#/rivers
Simulator         http://localhost:8080/#/simulator
Monitor log       http://localhost:8080/#/monitor
On your network   http://192.168.x.x:8080/
```

**Opening it from other devices:** any PC or phone on the same network can open `http://<your-ip>:8080/` and see the same live data. On Windows, allow Python on *Private networks* the first time it asks. A corporate network may still block inbound connections; `localhost` always works.

**Options:**
- `python server.py --port 9000`
- `--host 127.0.0.1` (this PC only)
- `--reset` (re-seed all data)

**Environment variables:** `FFS_PORT`, `FFS_HOST`, `FFS_DATA_DIR`, `FFS_SIM_TOKEN` (see §6).

## 2. Pages (one app, five tabs)

| Tab | What you get |
|---|---|
| **Dashboard** | KPI cards: Red/Orange weather areas, rivers above danger level, dams ≥ 90% full, warnings, monitor status. Map of India with three layers you can turn on and off: rain points (squares, coloured by IMD rain category), river stations (dots) and dams (triangles). Day selector: 48 h, 5 days, Today … day 5. Combined alert list (weather, rivers, dams), warnings, and details with 5-day strips and level charts. |
| **Weather** | Pick **State → District → Ward**, then switch between **2-day** and **5-day** forecasts. Day cards show rain in mm, IMD category, chance of rain, max/min temperature, wind/gusts, humidity and the warning colour with its reason. A district summary shows the peak rain per day. **Ward-wise outlook** (wards × days heat table) and **district-wise outlook** for the state. |
| **Rivers & dams** | Sortable tables of 77 river stations and 49 reservoirs, with filters, level charts, and warning / danger / HFL / FRL lines. |
| **Simulator** | **Rain & weather:** set one ward, a whole district or a whole state for any of the 5 days. Enter mm or **cm**, with optional wind, gusts and max temperature. Quick buttons: *15 cm tomorrow*, heavy, very heavy, extremely heavy, no rain. An optional link raises river forecasts and dam inflow in the same district.<br>**River level:** set a station's level.<br>**Dam level:** state → district → dam; shows full and current level, with a gauge, slider and quick buttons.<br>**Basin scenario**, **custom warning** and **reset**. |
| **Monitor** | Whether `monitor.py` is running (heartbeat), plus the live table of everything it reported. |

### Warning colours

| Source | Green | Yellow | Orange | Red |
|---|---|---|---|---|
| **Rain (IMD 24 h)** | < 64.5 mm | heavy 64.5–115.5 | very heavy 115.6–204.4 | extremely heavy ≥ 204.5 |
| **Wind gusts** | < 50 km/h | ≥ 50 | ≥ 70 | ≥ 90 |
| **Heat (max °C)** | < 42 | ≥ 42 | ≥ 45 | ≥ 47 |
| **River level** | below warning | ≥ warning level | ≥ danger level | ≥ highest flood level |
| **Dam** | < 80% | ≥ 80% | ≥ 90% | at or above FRL |

Orange and Red create **automatic warnings**. Weather warnings are created only for Orange and Red; river and dam warnings start at Yellow (above normal). The map colour for a river station uses the worse of its current and forecast level.

## 3. Monitor (`monitor.py`)

`monitor.py` is a **rule-based watcher**, not an AI agent. It listens to the server's live feed, reads `/api/snapshot` on every change and works out the current alerts:

| Level | Meaning |
|---|---|
| **EXTREME** | Red weather · river at/above HFL · dam at/above FRL |
| **HIGH** | Orange weather · river above danger level · dam ≥ 90% |
| **WATCH** | Yellow — only with `--include-yellow` |
| *(plus)* | every active manual warning |

It reports **only changes**: `NEW`, `UPGRADED`, `UPDATED`, `DOWNGRADED`, `CLEARED`.

**Where you see the output:**
1. **The console window** opened by `monitor.bat`.
2. **`logs/monitor.log`**: the same lines as text.
3. **`logs/alerts.jsonl`**: one JSON object per line, for another program or agent to read.
4. **The Monitor tab** in the web app, where the monitor also posts what it found.

Example console line:

```
[2026-11-11 08:37:09] NEW             HIGH     RAIN  Bellandur (Bengaluru Urban, Karnataka) - Orange - Very heavy rain 150 mm Tomorrow
```

**Options:**

```
python monitor.py --url http://192.168.1.25:8080   # simulator on another PC
python monitor.py --include-yellow                   # also report Yellow / above normal
python monitor.py --no-report                        # don't post to the web app
```

If the server isn't up yet, it waits. If the live feed drops, it polls every 10 s and says **SOURCE UNREACHABLE** rather than going quiet. It ignores system proxies, because the simulator is local.

## 4. Quick demo (2 minutes)

1. Double-click `start.bat`, then `monitor.bat`.
2. **Simulator → Rain & weather**: Karnataka → Bengaluru Urban → Bellandur → **15 cm tomorrow** → *Apply*.
3. The result is **Orange** (very heavy rain, 150 mm). The Dashboard KPI changes, Bellandur appears in Alerts, the Weather tab shows 150 mm for Tomorrow, and the monitor prints `NEW HIGH RAIN Bellandur…`.
4. **Simulator → Dam level**: Karnataka → Mandya → KRS → *FRL + 0.5 m* → Submit. The monitor prints `NEW EXTREME DAM Krishna Raja Sagara (KRS)…`.
5. Click **Reset to seed data** beside **Active warnings** on any Simulator tab,
   or use **Simulator → Reset → Reset all data**. Confirm to remove custom changes
   and restore all forecasts, river levels, dam levels and warnings to the seed.
   Some seed high/extreme alerts remain; this is not an all-safe reset.
   Open simulator pages refresh automatically. Monitor history is retained,
   and removed alerts produce `CLEARED` lines.

## 5. Architecture

```
Browser (any tab, any device)
   │  GET /api/snapshot · /api/weather/{id} · /api/stations/{id} · /api/reservoirs/{id}
   │  POST /api/sim/rain · /api/sim/station/{id} · /api/sim/reservoir/{id} · /api/sim/scenario · /api/sim/warnings · /api/sim/reset
   ▼
app/http.py      HTTP layer: routing, static files, gzip, JSON API, Server-Sent Events (/api/stream)
app/services.py  middle layer: IMD rain categories, warning colours, validation, auto-warnings, rain→river link, events
app/db.py        data layer: SQLite (data/ashraay_sim.db), seeding, daily forecast roll-over
app/events.py    event bus → every change is pushed to all browsers and the monitor
app/seed_data.py 77 river stations · 49 reservoirs · 69 city wards in 11 districts + 1 HQ point for 106 other districts
web/             single-page app (no frameworks): index.html, assets/js/*.js, assets/css/app.css, offline basemap
monitor.py       the watcher (console + logs/ + posts to /api/monitor/report)
tests/           test_api.py (backend + monitor) · ui_e2e.py (browser test, optional)
```

**How a change reaches every page and the monitor:**
1. A simulation POST writes to SQLite.
2. The service recalculates the warnings.
3. `bus.publish()` notifies every open `/api/stream` connection.
4. Each browser re-fetches the snapshot and redraws in place; the monitor works out what changed and logs it.
5. If the live feed is blocked, pages fall back to polling `/api/version` every 4 s.

**Forecast days roll over automatically.** When the date changes, yesterday drops off and a new day 5 is generated. Simulated days keep their values.

### API examples

```
POST /api/sim/rain
{"scope":"ward","area_id":"W-BENGALURU-URBAN-BELLANDUR","day":1,"rain":15,"unit":"cm","propagate":true}
{"scope":"district","state":"Karnataka","district":"Bengaluru Urban","day":2,"rain":250}
{"scope":"state","state":"Kerala","day":0,"rain":120,"wind_kmh":45,"gust_kmh":75}
POST /api/sim/reservoir/RSV-KRS   {"level":752.9,"inflow_cumecs":2500}
POST /api/sim/station/GNG-PTN     {"level":50.8,"forecast_level":51.0}
GET  /api/weather/W-BENGALURU-URBAN-BELLANDUR      full 5-day forecast for one ward
GET  /api/monitor                                    monitor status + reported lines
```

`day` is 0 for today through 4 for day 5. `unit` is `mm` (default) or `cm`. Area IDs are listed in `/api/meta`.

## 6. Security
- The server listens on all interfaces so your IP works. The simulation endpoints have **no login by default**.
- To protect them, set a token before starting:
  - **Windows:** `set FFS_SIM_TOKEN=my-secret` and then `start.bat`.
  - **macOS/Linux:** `FFS_SIM_TOKEN=my-secret ./start.sh`.
- The web pages then ask for the token once. Start the monitor with the same variable set, or `--token my-secret`.
- Use `--host 127.0.0.1` to keep it on your PC only. Don't expose it to the internet.

## 7. Tests

```
python -m unittest discover -s tests -v      # backend + monitor, standard library only (11 tests)
python tests/ui_e2e.py                       # optional browser test: pip install playwright && playwright install chromium
```

The browser test starts its own server and the monitor. It then checks, in a real browser:
- 15 cm rain, a dam above FRL, a river at extreme, 250 mm over a whole district, a custom warning and a reset
- live updates on the dashboard, weather and monitor pages
- the monitor log files

## 8. Changing the data
- **Your own data:** edit `app/seed_data.py` to add wards (name, lat, lon) under a state/district, add stations or dams, or correct levels with official values. Then run `python server.py --reset`.
- **Generated weather:** seed weather comes from simple per-state climate values (`STATE_CLIMATE`); real IMD data can replace it later.
- **Maps:** the offline basemap is simplified Natural Earth with **indicative boundaries**. *Street map* uses OpenStreetMap tiles when internet is available.

## 9. Known limits
- **Not production:** a single-process server for demos and a small team.
- **Open tabs:** browsers allow about 6 connections per site; each open tab uses one for live updates. With many tabs open, close some.
- **Rough approximations:** dam storage % uses an approximate level–capacity curve, and the rain → river link is a simple stand-in, not a hydrological model.
