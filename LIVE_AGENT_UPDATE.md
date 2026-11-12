# Live agents + location-free alerts — update notes

Copy these files over your `Exp_project` folder (same paths), then restart the API, Command Center and Mobile App.
No new packages and no new database tables.

## What changed

**Location is never used to filter, rank or target alerts or volunteers.**
Latitude/longitude, city and landmark are still stored and shown (map, weather, Location picker, volunteer location screen), but:
- **Dashboard:** the Hazard Intelligence and Hazard Response tiles show every alert in the system, whichever city is selected. Alerts are ranked by severity and confidence only.
- **Agent 2 (analysis):** counts every open citizen report and check-in instead of matching by landmark text.
- **Volunteers:** distance-based volunteer selection and the "next-nearest" escalation are removed.
- **Simulator sources:** sources without coordinates are still accepted.
- **Event Simulator:** inputs for any city are accepted; previously, cities outside the fixed list of 7 were skipped.

**Agents are live all the time.**
- **Starts with the API:** the agent loop starts automatically (`ASHRAAY_AGENTS_AUTOSTART=0` starts it paused).
- **Every 10 seconds it:**
  1. picks up new Event Simulator inputs (any city) and raises or updates alerts;
  2. reads every elevated source from the ASHRAAY Hazard Simulator (`ASHRAAY_SIM_URL`). It raises an alert per source (up to 8 new per tick) and updates an existing alert when its readings change. Turn this off with `ASHRAAY_AGENT_SIM_FEED=0`;
  3. checks citizen reports and check-ins from the mobile app. It keeps one "People need help - citizen reports" alert up to date, with recommendations, and adds an "Agent update" note with a fresh recommendation to every active alert when new user events arrive.
- **Start / Stop:** stays on the Hazard Prediction & Dispatch screen. Stop pauses the loop; Start resumes it and picks up anything sent while it was paused.
- **Without a language model:** if no Copilot token/model is configured, or Copilot fails, the agents use built-in rules (severity, confidence, flood window and recommended actions), so they never stop. Copilot is still used when it is configured.

**Decisions happen only on the Dashboard.**
- **Approve & send** now dispatches the alert:
  - publishes a citizen notice to **every registered user** (mobile app Alerts and Home);
  - records a simulated delivery;
  - asks **every active volunteer** (verified and "I am available") to accept or decline.
- **Late volunteers:** anyone who becomes active later is asked automatically within a few seconds.
- **Reply window:** volunteers have 30 minutes to reply (`ASHRAAY_VOLUNTEER_RESPONSE_SECONDS`).
- **Alert stays open:** an alert is no longer auto-closed when enough volunteers accept; it stays on the dashboard while the response runs.
- **What the dashboard shows:** both hazard tiles show "Sent to all N registered users · M volunteers asked: x accepted · y declined · z waiting". Layout is unchanged.
- **Hazard Prediction & Dispatch screen:** read-only apart from Start/Stop. It shows live agent status, and each alert has a "Decide on the Dashboard" button.

**Mobile app**
- **Request wording:** volunteer requests now read "Hazard alert — are you available?" (was "Hazard nearby").
- **Location screen:** the volunteer location text no longer says it is used for matching.

**Translations:** all new labels are added in Hindi, Tamil, Malayalam and Kannada. Agent-generated text (reasons, update notes) stays in English, as before.

## Files
- `command-center/web-app/app/live_agent.py` (new): location-free rules, citizen signals, notices, active volunteers.
- `command-center/web-app/app/main.py`: live agent loop, dispatch to all, rules fallback, location-free analysis and volunteer requests, official alerts.
- `command-center/web-app/app/sim_feed.py`: `simulator_candidates()` returns every source; coordinates optional.
- `command-center/web-app/tests/test_live_agent.py` (new).
- `command-center/dashboard.js`, `dashboard.css`, `hazard.js`, `app.js`, `index.html`, `i18n-command.js`.
- `mobile-app/app.js`, `mobile-app/i18n-mobile.js`.

## Not changed
- **Layout:** the dashboard layout and the other tiles.
- **Report grouping:** reports with the same landmark text are still grouped into one incident (duplicate detection, not alert filtering).
- **Separate system:** the Node agents in `agents/`.
