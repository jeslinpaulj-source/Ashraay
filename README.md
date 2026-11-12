# ASHRAAY Flood-Response Pilot Simulator

This repository is a local, synthetic-data simulator for the ASHRAAY flood-response workflow. It is not a
production emergency-response service and must not be used to issue real warnings, dispatch responders, or
collect real citizen data.

The repo is organized around three standalone pieces plus a database and shared/agent support code:

```
command-center/   Staff web app (command sender) - static HTML/JS/CSS, served by command-center/server.js;
                  nests web-app/ (see below)
command-center/web-app/
                  FastAPI backend (app/, requirements.txt) - the API both apps talk to
mobile-app/       Resident/volunteer/field-team PWA - static HTML/JS/CSS, served by mobile-app/server.js
shared/           Browser helpers (auth, i18n, offline queue) used by command-center and mobile-app,
                  plus static-server.js, the tiny static file server both apps run on
agents/           Standalone Node.js process running agents A1 (evidence), A2 (prediction), A3 (planner)
database/         PostgreSQL setup/migration scripts (local-postgres.py, migrate-postgres.py); the runtime
                  schema itself is created by command-center/web-app/app/database.py on startup
other/            Everything else from the previous architecture (event simulator, dummy sources,
                  prediction site, source agent, Keycloak config, Docker Compose, the old VS Code
                  extension host) kept as-is for manual review/removal
```

## Running the three pieces

Each piece is an independent process; none of them requires VS Code.

Run `.\start-server.bat` from the project root to launch the complete local stack.
For a manual API launch, first load its database connection in the same PowerShell session:

```powershell
$env:DATABASE_URL = (Get-Content .\.local-data\postgres.json -Raw | ConvertFrom-Json).databaseUrl
```

Command Prompt assignments must use `set "DATABASE_URL=..."` so spaces before
`&&` are not included in the database name. API startup initializes the schema
before resetting or restoring simulator state.

If `.local-data\postgres.json` was copied from a different cluster, restore the
original credentials file first. If it is unavailable, explicitly rotate the
project-local passwords without deleting or recreating the database:

```powershell
.\.venv\Scripts\python.exe database\local-postgres.py reset-passwords
```

This stops the project PostgreSQL temporarily, rotates its three local role
passwords in offline maintenance mode, synchronizes the connection port, and
restarts it. Private recovery/previous-configuration files remain in `.local-data`.
Restart API/agent processes afterward so they load the new credentials.
Do not copy a credentials file from a different database or delete the cluster
directory to resolve a connection error.

```powershell
# 1. Database - provision/inspect local PostgreSQL
.\.venv\Scripts\python.exe database\local-postgres.py status

# 2. Web app (API)
cd command-center\web-app
..\..\.venv\Scripts\python.exe -m pip install -r requirements.txt
..\..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
cd ..\..

# 3. Command center (staff dashboard) on http://127.0.0.1:5173
node command-center\server.js

# 4. Mobile app (resident/volunteer/field-team PWA) on http://127.0.0.1:5174
node mobile-app\server.js

# 5. Agents (A1/A2/A3), talking to the API with their own credentials
node agents\run.js
```

Or, from the repo root, use the npm shortcuts in [package.json](./package.json):

```powershell
npm run start:web-app
npm run start:command-center
npm run start:mobile
npm run start:agents
```

### Simulated hazard response

- The dashboard's risk tiles use the selected city's Event Simulator input when
  one exists, instead of unrelated live-weather readings. Saved inputs are scanned
  after restart, and updated inputs refresh the alert and model outlook.
  Non-seeded predictions appear ahead of synthetic sample cards.
- Approve the hazard: every registered volunteer account (and verified external
  volunteer profile) receives an availability request in the mobile app, even
  without a separate enrolled/verified profile. Already approved, open alerts
  also pick up newly registered volunteers automatically. Choosing
  **Yes, I am available** records their willingness and marks an existing profile available
  for this alert. **Not now** declines this alert without changing other alerts.
  Both replies and volunteer names are shown on the dashboard. An unanswered
  request can still be answered later while the approved response remains open.
- Only approved hazards explicitly sent from Intelligence appear in Response.
  Commanders can also choose **Send to Response** on an open incident report
  or an at-risk/need-help person's check-in. These handoffs keep their audience
  scoped to that request rather than including unrelated reports.
- Choose **Send all tasks to field** once for the response plan. This offers every
  pending action and its details only to eligible volunteers who accepted this alert; the first
  acceptance assigns it exclusively. A declined offer remains available to other
  volunteers. If everyone declines or the assignee reports a blocker, staff can
  review and send the step again.
- This account-only eligibility applies to simulated hazard tasks only.
  Ordinary tasks still require a verified, available profile. Existing
  withdrawn or rejected profiles cannot join; no verified profiles are
  automatically created.
- Citizens with active help reports or latest **Need help**/**At risk** check-ins form
  the response's audience, snapshotted at approval and deduplicated by account. When none exist,
  registered demo citizen accounts receive the updates instead. At least one
  recipient account is required. Location does not filter this demo audience.
- The mobile app's **Tasks** and **Alerts** show the exact step, location, and
  details. Acceptance updates citizens with the volunteer's name and a clearly
  simulated "help is on the way" message. The dashboard names the volunteer.
- After **Arrived**, the volunteer supplies a photo or voice note, optionally
  adds a text note and people-assisted count, and submits completion.
  Images are resized to JPEG (JPEG/PNG accepted, up to 2 MB); voice notes can be
  recorded for up to two minutes or uploaded as WebM/Ogg/MP3/WAV/M4A (up to 2 MB).
  Microphone recording requires HTTPS or localhost; uploads work on LAN HTTP.
  Citizens can select shelter, prepositioning, rescue, boat, or other assistance
  in **Alerts**; the commander sees those choices in Response. They can choose
  **Yes, I am safe - acknowledge** immediately, even before field dispatch or
  completion evidence. This closes only their linked reports/check-in and
  acknowledges their safety across the plan, without waiting for other citizens.
  Other citizens remain open; the plan closes once all its recipients are safe.
  Evidence remains viewable within the response tile without resizing its text columns.
- Updates and photos persist in the demo database. These are in-app updates
  while the web app is running, not closed-app push, SMS, or real emergency
  dispatch. Use demo accounts and non-sensitive demonstration photos/recordings only.
  The full-stack launcher now defaults to `ASHRAAY_RESET_ON_START=0`, preserving
  volunteer profiles and confirmations across restarts. Set it explicitly to
  `1` to reset on startup, or use the existing manual reset action. Direct API
  launches still default to reset unless the environment variable is set.

### Agent configuration

`agents/run.js` reads its configuration from environment variables (no VS Code settings involved):

| Variable | Default |
|---|---|
| `ASHRAAY_AGENT_DATABASE_URL` | (required - PostgreSQL connection string) |
| `ASHRAAY_API_BASE_URL` | `http://127.0.0.1:8000/api/v1` |
| `ASHRAAY_TOKEN_URL` | `http://127.0.0.1:8090/token` |
| `ASHRAAY_PREDICTION_URL` | `http://127.0.0.1:5177/prediction.html` |
| `ASHRAAY_PREDICTION_POLL_SECONDS` | `300` |
| `ASHRAAY_INBOX_POLL_MS` | `500` |
| `ASHRAAY_RETENTION_DAYS` | `30` |
| `ASHRAAY_CLIENT_ID_PREFIX` | `ashraay-agent-` |
| `ASHRAAY_LOG_FILE` | `database/.local-data/agent-communications.log` |
| `ASHRAAY_AGENT_A1_SECRET`, `ASHRAAY_AGENT_A2_SECRET`, `ASHRAAY_AGENT_A3_SECRET` | (required - client credentials per agent) |

The standalone runner always uses the agents' deterministic built-in rules (there is no editor-hosted
language model to call outside VS Code); every exchange between agents is still saved as readable English
text in the database and in the log file.

## What is implemented

- PostgreSQL-backed durable simulator state, audit history, and a traceable event feed.
- Two browser experiences: Command Center (staff) and a resident/volunteer/field-team mobile PWA.
- Three agents (A1 evidence, A2 prediction, A3 planner) running as one standalone Node.js process:
  database triggers queue work for them when data changes, A2 checks a synthetic prediction website on a
  timer, they talk to each other through the database using deterministic rules, and save every exchange
  as readable English in `agent_message` and an append-only log file. Each agent has its own credentials
  and API role and cannot approve, dispatch, or read operational state directly.
- English, Hindi, Tamil, Malayalam, and Kannada UI selection in both apps; the choice is saved locally per
  browser.
- Flood forecast intake, warning-plan drafting, citizen check-ins and reports, deterministic A1
  verification, duplicate grouping, low-confidence human review, A3 response planning, revision-bound
  approvals, simulated alert delivery, and field-task transitions.
- Installable-manifest mobile PWA; consent-gated account-scoped offline report/check-in queue, privacy
  export, and response-coordination consent withdrawal.
- CloudEvents-compatible event records with transactional simulator outbox/inbox, retry/dead-letter/replay
  controls, synthetic resource holds, and capacity checks before rescue-plan approval.
- Idempotency-key enforcement, immutable plan revisions, deterministic agent confidence capped at 0.70,
  verifier review before planning, and server-enforced human approval.

The agents are deterministic demo rules, not trained AI models. Delivery channels and official data feeds
are simulated. The database currently persists the pilot's aggregate state in one JSON record and a single
API instance; this is a durable single-instance simulator, not a normalized/high-availability production
data platform. Offline submissions are stored in browser IndexedDB, which is not encrypted in this demo;
use synthetic data only.

## Other components

Components not part of the three-piece architecture above (event simulator, dummy sources, synthetic
prediction site, standalone source-monitor agent, Keycloak realm config, Docker Compose, and the previous
VS Code extension host) were moved as-is into [other/](./other/) rather than deleted, so they can be
reviewed and removed individually.

## Demo accounts (for components kept in other/)

| Account | Password | Role |
|---|---|---|
| `commander` | `Commander-Demo-Only-1!` | Incident Commander |
| `verifier` | `Verifier-Demo-Only-1!` | Verifier |
| `resident` | `Resident-Demo-Only-1!` | Resident Reporter |
| `field-team` | `Field-Demo-Only-1!` | Field Team / Volunteer |
| `platform-admin` | `Admin-Demo-Only-1!` | Platform Admin |

Keycloak administrator defaults are `admin` / `local-demo-only-change-before-use`. These credentials, the realm's development HTTP configuration, and the PostgreSQL sample password are strictly for the local demo. If you change the PostgreSQL password, update both `POSTGRES_PASSWORD` and the matching password inside `DATABASE_URL`. Change the identity administrator credentials or use a properly secured identity/database deployment before exposing the services to any network.

## Exercise the operational flow

In the Command Center, use **Decision Gate** for approvals/reviews, **Resources + shelters** for volunteer verification, **Agents + reliability** for live agent heartbeats and the English conversation log, and **Audit trail** for recorded decisions/events.

In the mobile app, sign in as **Resident** for Home/Report/My reports/Alerts/More, **Volunteer** for enrolment and Tasks, or **Field team** for approved field tasks. Report submission has three steps: details and needs, landmark/optional location, review and consent. Photos/voice uploads and live maps are not implemented; the screens say so rather than displaying fake operational data.

1. Start the ASHRAAY Hazard Simulator from [ashraay-sim](./ashraay-sim) (or send requests to the API directly) signed in as `commander`; start A1-A3 via `node agents\run.js`.
2. Send a simulated rainfall/river forecast. A high-risk reading creates a warning plan.
3. Send a community report and run A1. Deterministic output is capped at 0.70, so reports require verifier review before A3 planning. Submit a second report at the same landmark to exercise duplicate grouping.
4. Send a low-confidence social report; A1 places it in the human review queue. Sign in as `verifier` in the Command Center to confirm, dismiss, or request a field check.
5. After verifier confirmation, run A3. In the Command Center, inspect the synthetic resource holds, modify the rescue plan if needed, and approve the current revision. Plans with unmet resource needs, missing/expired resource holds, or expired proposals cannot be approved; earlier revisions cannot be approved. Expiry is checked during the decision request as well as by the worker.
6. Approving a warning creates a simulated delivery record. Approving a rescue plan releases a task to the field app.
7. Sign in to the mobile app as `field-team`, accept the task, arrive, report a blocker or complete it. A blocker creates a new plan revision for review.
8. Use the reliability panel to dispatch pending events, simulate retry failures, dead-letter and replay an event, or sweep expired plans/holds. In the mobile app, export the signed-in user's data or withdraw response-coordination consent. Watch the event feed, approvals, audit history, deliveries, resources, and task timeline in the Command Center.

The field-task claim is bound to the identity that accepts it. Citizens can view their own report status; operational views require staff roles. Reset is restricted to Platform Admin.

## Configuration for an external OIDC provider

The API validates tokens using the configured issuer, JWKS endpoint, and audience. Configure the browser's public OIDC client with Authorization Code + PKCE and exact redirect URLs for ports 5173–5174. Set these variables in the deployment environment:

- `OIDC_ISSUER`: exact `iss` claim value.
- `OIDC_CLIENT_ID`: public browser client ID.
- `OIDC_JWKS_URL`: provider JWKS endpoint.
- `OIDC_AUDIENCE`: API access-token audience.
- `OIDC_ROLES_CLAIM`: dot-separated role-claim path; use `roles` for a flat app-role claim, or `realm_access.roles` for the supplied Keycloak realm.
- `OIDC_SCOPES`: scopes requested by the browser client; include the provider's API-access scope when required.
- `CORS_ORIGINS`: comma-separated, exact browser origins.

Create role/app-role assignments matching `resident-reporter`, `volunteer`, `field-team`, `incident-commander`, `verifier`, `response-agency`, and `platform-admin`. This application does not create a tenant, register an Entra application, assign MFA policies, or manage production users. Those are identity-provider administrator tasks. The bundled Keycloak is a development identity service, not a production identity configuration.

## How the database is created and accessed

With Docker Compose (see [other/docker-compose.yml](./other/docker-compose.yml)), the PostgreSQL image creates the configured database and user in its persistent `pgdata` volume. There is no initialization SQL script; the runtime schema is created on API startup as described below.

On API startup, [the persistence module](./command-center/web-app/app/database.py) creates `demo_state`, `outbox_event`, `inbox_event` and seven `agent_*` tables in the default schema, installs transactional PostgreSQL fanout triggers, and upgrades epoch-millisecond columns to BIGINT. Domain data remains in the singleton `demo_state` JSONB row. A successful mutation saves the aggregate and new outbox events in one transaction. A database write failure returns HTTP 503 and restores the last committed in-memory state. Restart reloads the committed aggregate.

Browser apps send authenticated REST requests, not direct database queries. The API uses SQLAlchemy/asyncpg as `app_user`. The standalone agents process uses the asynchronous `pg` adapter as `agent`, with read-only operational tables and write access only to inbox/message/run/state/heartbeat tables. PostgreSQL triggers enqueue work atomically; `LISTEN/NOTIFY` wakes the runtime after commit, with polling for recovery. Queue claims use `FOR UPDATE SKIP LOCKED`. API role boundaries and human approvals remain mandatory. Separate database roles for each agent, normalized PostGIS repositories and jurisdiction authorization remain production work.

## Production work remains

Before any pilot with real people or data, replace the simulator persistence with normalized PostgreSQL/PostGIS tables and transactional inbox/outbox, deploy HTTPS, configure the production IdP/MFA and jurisdiction-scoped roles, add real source/channel adapters and media scanning, complete privacy/retention controls, add database migrations/backup and recovery drills, and run security, accessibility, load, and field acceptance testing. The HLD's section 26 checklist remains applicable.
