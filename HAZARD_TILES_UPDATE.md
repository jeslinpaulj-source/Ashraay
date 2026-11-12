# Hazard Intelligence + Hazard Response tiles — update notes

Copy the files in this package over your `Exp_project` folder, keeping the same paths.
Nothing else in the project needs to change, and there is no new package or install step.

## Files

| File | Change |
|---|---|
| `command-center/web-app/app/hazard_intel.py` | **New.** Severity tier logic, backfill of new fields, decision log, Agent 1 outlook record, and the Bengaluru demo seed. |
| `command-center/web-app/app/main.py` | Imports the module above. Adds the new fields when an alert is created, approved, rejected, escalated or sent to the field. Loads the seed on start and on **Reset demo data**. |
| `command-center/index.html` | New markup for the two tiles. The **Location** picker moves from Risk Outlook to the page header. |
| `command-center/dashboard.js` | Rewrites only the Hazard Intelligence + Hazard Response section, plus the click handlers for those tiles. |
| `command-center/dashboard.css` | New `hzi-` / `hzr-` styles and the header location picker. The left column is wider so the tiles fit. |
| `command-center/app.js` | Shows the Location picker only on Dashboard, Weather and Hazard Prediction. |
| `command-center/i18n-command.js` | New labels and the demo alert text in Hindi, Tamil, Malayalam and Kannada. |

## Backend data: new fields, no new tables

All data stays in the existing `demo_state` JSON record (`hazardAlerts`). Each alert gets these new fields:

| Field | Meaning |
|---|---|
| `tier` | `extreme` / `severe` / `moderate` / `minor`. The old `severity` (high/medium/low) is unchanged, because volunteer dispatch and the Copilot schema still use it. For alerts created by an agent scan: `high` + confidence ≥ 0.80 → extreme, `high` → severe, `medium` → moderate, else minor. |
| `hazardType`, `area`, `title`, `summary` | Shown on the card. |
| `rainMm`, `rainWindowHours`, `rainSource`, `reservoirSource`, `floodPeak` | The four figures on the card, with their sources. |
| `revision`, `decisionLog[]` | Who decided what, and when. **Modify + Approve** raises the revision. |
| `approvedAt`, `planApprovedAt`, `responsePlan[].progress` | The approved timeline and the response tracker. |

Alerts stored before this update are filled in automatically on start.

The state also gets a new top-level `hazardOutlook[cityId]`, written by every Agent 1 scan (`/hazards/scan`):
rain, reservoir %, flood-risk index, model run time and next run time. The **All clear** tile shows these values.
Until the first scan for a city, it shows "–".

**Response stage** (step 1–6) is worked out from the stored statuses:

| Stored state | Stage |
|---|---|
| Awaiting decision | Predicted |
| Approved | Planned / Plan ready for review |
| A step is in the field | In field |
| All steps done | Closed |

## Demo data

On start, and after **Reset demo data**, four synthetic Bengaluru alerts are loaded:

| Alert | Tier | Stage |
|---|---|---|
| Bellandur flood | Extreme | Awaiting approval |
| Outer Ring Road waterlogging | Severe | In action |
| Yelahanka gusts | Moderate | Plan ready for review |
| Day heat | Minor | Monitoring |

- **Turning them off:** set `ASHRAAY_SEED_HAZARD_DEMO=0` before starting the API.
- **Agent scans:** demo alerts never block a real Agent 1 scan for the same city.

## How the tiles behave

**Both tiles**
- They show alerts for the city chosen in the header Location picker that are not rejected, ignored or resolved, sorted from Extreme to Minor.

**Hazard Intelligence**
- **Filters:** severity chips with counts.
- **Navigation:** ‹ n / N › arrows.
- **Waiting alerts:** **Approve & send to Hazard Response**, **Modify**, **Reject** and **Escalate** (one click, using the existing endpoints).
- **Approved alerts:** a timeline, plus **View plan progress** and **Open audit trail**.
- **Minor alerts:** shown as "Monitoring", with no action buttons.
- **No alerts:** the All clear state.

**Hazard Response**
- **Counts:** In action, Awaiting approval, Actions in field, Completed.
- **Current alert:** one card with a 6-step tracker and the status of each action. **Send to field** and **Mark complete** call the existing step endpoints.
- **Up next:** the next 3 alerts.
- **No alerts:** a Standing by state, using the resources from the backend.

## Not changed
- **Dashboard tiles:** the map, Weather & Environmental Data, Incident Reports & Check-ins, the KPI row and the Risk Outlook content.
- **Other parts of the app:** the other screens, the mobile app and the agents.

## Notes
- **Agent text language:** alert text written by the agent at run time (title, summary, actions) stays in English, as it does today. The demo alert text and all labels are translated.
- **Fresh database start:** with `ASHRAAY_RESET_ON_START=1` (the default), the API does not create tables on a brand-new empty database. This is existing behaviour; your launcher normally handles it. Start once with `ASHRAAY_RESET_ON_START=0` if you ever start from an empty database.
- **Line endings:** files are saved with LF line endings.

## Compact layout update

**Tiles made smaller**
- Removed the one-line agent description under both tile titles.
- The severity chips (All · Extreme · Severe · Moderate · Minor) now sit on one line. If a language's labels don't fit, the chips automatically show only the coloured dot and count; the full name stays as a tooltip. "High → low" is now a small filter icon with a tooltip.
- The ‹ 1/4 › arrows sit on the same row as the severity and location tags.
- The four figures are in one row, the summary is limited to 2 lines, and the action buttons are on one row. The primary button now reads "Approve & send"; the full wording shows as a tooltip.
- In Hazard Response, the tracker and status sit beside the alert title, and "Up next" shows 2 alerts.

**Alignment**
- The three dashboard columns now start and end at the same line. The map grows to the height of the left column, and Incident Reports & Check-ins fills the right column.

**Bug fixes**
- Your existing `.hr` style was adding a 12 px gap under the Hazard Response icon.
- The new column widths no longer stop the dashboard collapsing to one column on narrow screens.

**Files changed in this update:** `command-center/index.html`, `dashboard.js`, `dashboard.css` and `i18n-command.js` (one new label: "Approve & send"). The backend is unchanged.
