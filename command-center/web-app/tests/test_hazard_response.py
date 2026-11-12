import base64
import io
import wave
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def response_app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app import database, main
    from app.security import Principal, verify_token

    engine = create_async_engine(
        "sqlite+aiosqlite:///" + (tmp_path / "response.db").as_posix()
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "sessions", sessions)
    monkeypatch.setattr(main, "sessions", sessions)
    monkeypatch.setattr(main, "S", main.initial())
    monkeypatch.setattr(main, "persisted_state", main.initial())
    monkeypatch.setattr(main, "RESET_ON_START", True)
    monkeypatch.setattr(main, "SEED_HAZARD_DEMO", False)
    monkeypatch.setitem(main.auto_run, "running", False)
    monkeypatch.setattr(main, "agent_seen_sources", {})
    monkeypatch.setattr(main, "auto_run_seen_events", set())
    monkeypatch.setattr(main, "agent_user_fingerprint", {"value": None, "signals": None})
    for worker in ("reliability_worker", "volunteer_escalation_worker", "simulation_agent_worker"):
        monkeypatch.setattr(main, worker, AsyncMock())
    monkeypatch.setattr(main.copilot_agent, "shutdown", AsyncMock())

    actor = {"subject": "commander", "roles": frozenset({"incident-commander"})}

    def identity():
        return Principal(actor["subject"], actor["roles"])

    main.app.dependency_overrides[verify_token] = identity
    try:
        async with main.lifespan(main.app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                yield main, database, client, actor
    finally:
        main.app.dependency_overrides.pop(verify_token, None)
        await engine.dispose()


def seed_response(main):
    main.S["volunteers"] = [
        {"id": f"V{i}", "subject": f"volunteer-{i}", "displayName": f"Volunteer {i}",
         "status": "verified", "available": True}
        for i in (1, 2)
    ]
    main.S["reports"] = [
        {"id": "report-1", "owner": "citizen-1", "status": "received", "people": 1, "incidentId": "incident-1"}
    ]
    main.S["incidents"] = [
        {"id": "incident-1", "reportIds": ["report-1"], "status": "verified"}
    ]
    main.S["checkins"] = [
        {"id": "checkin-2", "owner": "citizen-2", "status": "need_help", "time": main.now()}
    ]
    alert = {
        "id": "hazard-1", "cityId": "test-city", "place": "Test city", "severity": "high",
        "reasons": ["Simulated flood risk"],
        "approvalStatus": "approved", "status": "dispatched", "volunteerRounds": 0, "responsePlan": [
            {"id": "step-1", "label": "Simulated assistance", "detail": "Demo only",
             "status": "awaiting_approval"}
        ],
    }
    main.S["hazardAlerts"].append(alert)
    main.dispatch_round(alert, main.S["volunteers"])
    for request in main.S["volunteerRequests"]:
        request["status"] = "accepted"
    return alert


def as_actor(actor, subject, role):
    actor.update(subject=subject, roles=frozenset({role}))


@pytest.mark.asyncio
async def test_bulk_dispatch_sends_every_pending_step_once(response_app):
    main, database, client, actor = response_app
    alert = seed_response(main)
    alert["responsePlan"].append({"id": "step-2", "label": "Shelter assistance", "status": "pending"})
    response = await client.post("/api/v1/hazards/hazard-1/plan/dispatch",
                                 headers={"Idempotency-Key": "all"})
    assert response.status_code == 200, response.text
    assert len(main.S["tasks"]) == 2
    assert {item["stepId"] for item in main.S["tasks"]} == {"step-1", "step-2"}
    assert all(step["status"] == "awaiting_volunteer" for step in alert["responsePlan"])
    assert all(task["recipientSubjects"] == ["citizen-1", "citizen-2"] for task in main.S["tasks"])
    assert (await client.post("/api/v1/hazards/hazard-1/plan/dispatch",
                             headers={"Idempotency-Key": "all"})).status_code == 409
    assert len((await database.load_state())["tasks"]) == 2
    as_actor(actor, "citizen-1", "resident-reporter")
    updates = (await client.get("/api/v1/my/response-updates")).json()
    assert len(updates) == 2
    assert all(item["canRespond"] for item in updates)


@pytest.mark.asyncio
async def test_bulk_dispatch_preflight_does_not_partially_send(response_app):
    main, _, client, _ = response_app
    alert = seed_response(main)
    alert["responsePlan"].append({"id": "step-2", "label": "Second task", "status": "pending"})
    main.S["volunteerRequests"].clear()
    response = await client.post("/api/v1/hazards/hazard-1/plan/dispatch",
                                 headers={"Idempotency-Key": "all"})
    assert response.status_code == 409
    assert not main.S["tasks"]
    assert [step["status"] for step in alert["responsePlan"]] == ["awaiting_approval", "pending"]
    alert["approvalStatus"] = "awaiting_approval"
    assert (await client.post("/api/v1/hazards/hazard-1/plan/dispatch",
                             headers={"Idempotency-Key": "unapproved"})).status_code == 409


@pytest.mark.asyncio
async def test_help_choice_and_immediate_safe_close_only_own_request(response_app):
    main, database, client, actor = response_app
    alert = seed_response(main)
    alert["responsePlan"].append({"id": "step-2", "label": "Shelter assistance", "status": "pending"})
    await client.post("/api/v1/hazards/hazard-1/plan/dispatch", headers={"Idempotency-Key": "all"})
    as_actor(actor, "other-citizen", "resident-reporter")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})).status_code == 403
    as_actor(actor, "citizen-1", "resident-reporter")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "boat"})).status_code == 200
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "invalid"})).status_code == 422
    as_actor(actor, "volunteer-1", "volunteer")
    task = (await client.get("/api/v1/my/tasks")).json()[0]
    assert task["assistanceNeeds"] == [{"need": "boat", "count": 1}]
    assert "responseChoices" not in task
    as_actor(actor, "citizen-1", "resident-reporter")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})).status_code == 200
    assert main.S["reports"][0]["status"] == main.S["incidents"][0]["status"] == "resolved"
    assert main.S["checkins"][0]["status"] == "need_help"
    assert all(item["confirmationCount"] == 1 and item["status"] == "offered" for item in main.S["tasks"])
    assert not alert.get("responseCompletedAt")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})).status_code == 200
    assert all(item["confirmationCount"] == 1 for item in main.S["tasks"])
    as_actor(actor, "citizen-2", "resident-reporter")
    await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})
    assert main.S["checkins"][0]["status"] == "safe"
    assert all(item["status"] == "completed" for item in main.S["tasks"])
    assert all(item["status"] == "completed" for item in alert["responsePlan"])
    assert (await database.load_state())["hazardAlerts"][0]["responseCompletedAt"]


@pytest.mark.asyncio
async def test_safe_before_dispatch_is_not_offered_more_work(response_app):
    main, _, client, actor = response_app
    alert = seed_response(main)
    await main.snapshot_response_audience(alert)
    as_actor(actor, "citizen-1", "resident-reporter")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})).status_code == 200
    as_actor(actor, "commander", "incident-commander")
    assert (await client.post("/api/v1/hazards/hazard-1/plan/dispatch",
                             headers={"Idempotency-Key": "all"})).status_code == 200
    assert main.S["tasks"][0]["recipientSubjects"] == ["citizen-2"]
    assert not alert.get("responseCompletedAt")


@pytest.mark.asyncio
async def test_existing_task_audience_migrates_without_adding_unrelated_people(response_app):
    main, _, client, actor = response_app
    alert = seed_response(main)
    await client.post("/api/v1/hazards/hazard-1/plan/dispatch", headers={"Idempotency-Key": "all"})
    del alert["recipientSubjects"]
    main.S["reports"].append({"id": "unrelated", "owner": "citizen-3", "status": "received"})
    as_actor(actor, "citizen-1", "resident-reporter")
    assert (await client.post("/api/v1/hazards/hazard-1/response", json={"need": "safe"})).status_code == 200
    assert alert["recipientSubjects"] == ["citizen-1", "citizen-2"]
    assert main.S["reports"][-1]["status"] == "received"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["report", "checkin"])
async def test_commander_referral_is_scoped_and_can_close_before_field_dispatch(response_app, kind):
    main, database, client, actor = response_app
    seed_response(main)
    if kind == "report":
        path = "/api/v1/reports/report-1/response"
        citizen = "citizen-1"
    else:
        main.S["checkins"][0]["status"] = "at_risk"
        path = "/api/v1/people/citizen-2/response"
        citizen = "citizen-2"
    as_actor(actor, citizen, "resident-reporter")
    assert (await client.post(path)).status_code == 403
    as_actor(actor, "commander", "incident-commander")
    response = await client.post(path)
    assert response.status_code == 200, response.text
    alert = response.json()
    assert alert["approvalStatus"] == "approved"
    assert alert["recipientSubjects"] == [citizen]
    assert not main.S["tasks"]
    assert (await client.post(path)).json()["id"] == alert["id"]
    as_actor(actor, "unrelated-citizen", "resident-reporter")
    assert not any(item["hazardAlertId"] == alert["id"] for item in (await client.get("/api/v1/my/response-updates")).json())
    assert not any(item["id"] == alert["id"] for item in (await client.get("/api/v1/alerts/official")).json())
    as_actor(actor, citizen, "resident-reporter")
    assert any(item["id"] == alert["id"] for item in (await client.get("/api/v1/alerts/official")).json())
    update = next(item for item in (await client.get("/api/v1/my/response-updates")).json()
                  if item["hazardAlertId"] == alert["id"])
    assert update["status"] == "ready" and update["canRespond"]
    await client.post(f"/api/v1/hazards/{alert['id']}/response", json={"need": "safe"})
    restored = next(item for item in (await database.load_state())["hazardAlerts"] if item["id"] == alert["id"])
    assert restored["responseCompletedAt"]
    assert main.S["reports"][0]["status"] == ("resolved" if kind == "report" else "received")
    assert main.S["checkins"][0]["status"] == ("safe" if kind == "checkin" else "need_help")


@pytest.mark.asyncio
@pytest.mark.parametrize("additional_step", [False, True])
async def test_field_task_accept_photo_and_all_citizen_confirmations(response_app, additional_step):
    main, database, client, actor = response_app
    alert = seed_response(main)
    if additional_step:
        alert["responsePlan"].append({
            "id": "step-2", "label": "Further simulated assistance", "status": "pending",
        })
    response = await client.post(
        "/api/v1/hazards/hazard-1/plan/step-1/approve",
        headers={"Idempotency-Key": "send-step"},
    )
    assert response.status_code == 200, response.text
    task = main.S["tasks"][0]
    task_id = task["id"]
    assert task["recipientSubjects"] == ["citizen-1", "citizen-2"]
    assert task["confirmationTotal"] == 2
    assert task["simulated"]
    assert alert["responsePlan"][0]["status"] == "awaiting_volunteer"
    if additional_step:
        assert alert["responsePlan"][1]["status"] == "awaiting_approval"
    assert (await client.post(
        "/api/v1/hazards/hazard-1/plan/step-1/approve",
        headers={"Idempotency-Key": "retry-step"},
    )).status_code == 409
    assert len(main.S["tasks"]) == 1

    as_actor(actor, "unrelated-volunteer", "volunteer")
    assert (await client.get("/api/v1/my/tasks")).json() == []
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions", json={"status": "accepted"}
    )).status_code == 403

    as_actor(actor, "volunteer-1", "volunteer")
    assert (await client.get("/api/v1/my/response-updates")).json()[0]["status"] == "offered"
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions", json={"status": "accepted"}
    )).status_code == 200
    assert alert["responsePlan"][0]["volunteerName"] == "Volunteer 1"
    assert "Volunteer 1" in alert["responsePlan"][0]["progress"]

    as_actor(actor, "volunteer-2", "volunteer")
    assert (await client.get("/api/v1/my/tasks")).json() == []
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions", json={"status": "on_site"}
    )).status_code == 403

    as_actor(actor, "citizen-1", "resident-reporter")
    update = (await client.get("/api/v1/my/response-updates")).json()[0]
    assert update["status"] == "accepted"
    assert update["volunteerName"] == "Volunteer 1"
    assert "recipientSubjects" not in update and "offeredTo" not in update
    assert (await client.get("/api/v1/my/reports")).json()[0]["helpOnTheWay"]
    assert (await client.post(f"/api/v1/tasks/{task_id}/confirm")).status_code == 409

    as_actor(actor, "volunteer-1", "volunteer")
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions", json={"status": "on_site"}
    )).status_code == 200
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions", json={"status": "completed"}
    )).status_code == 422
    assert (await client.post(
        f"/api/v1/tasks/{task_id}/transitions",
        json={"status": "completed", "completionPhoto": "data:image/jpeg;base64,bm90LWltYWdl"},
    )).status_code == 422
    photo = "data:image/png;base64," + base64.b64encode(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        )
    ).decode()
    response = await client.post(
        f"/api/v1/tasks/{task_id}/transitions",
        json={"status": "completed", "completionPhoto": photo, "peopleAssisted": 2},
    )
    assert response.status_code == 200, response.text
    assert task["status"] == "awaiting_confirmation"
    assert alert["responsePlan"][0]["status"] == "awaiting_confirmation"

    as_actor(actor, "other-citizen", "resident-reporter")
    assert (await client.get("/api/v1/my/response-updates")).json() == []
    assert (await client.post(f"/api/v1/tasks/{task_id}/confirm")).status_code == 403
    as_actor(actor, "citizen-1", "resident-reporter")
    assert (await client.get("/api/v1/my/response-updates")).json()[0]["canConfirm"]
    assert (await client.post(f"/api/v1/tasks/{task_id}/confirm")).status_code == 200
    assert (await client.post(f"/api/v1/tasks/{task_id}/confirm")).status_code == 200
    assert task["confirmationCount"] == 1
    assert task["status"] == "awaiting_confirmation"
    assert "Volunteer 1" in alert["responsePlan"][0]["progress"]
    assert main.S["reports"][0]["status"] == "received"

    as_actor(actor, "citizen-2", "resident-reporter")
    assert (await client.post(f"/api/v1/tasks/{task_id}/confirm")).status_code == 200
    assert task["status"] == alert["responsePlan"][0]["status"] == "completed"
    assert main.S["checkins"][0]["status"] == "safe"
    assert main.S["reports"][0]["status"] == ("received" if additional_step else "resolved")
    assert main.S["incidents"][0]["status"] == ("verified" if additional_step else "resolved")
    restored = await database.load_state()
    assert restored["tasks"][0]["completionPhoto"] == photo
    assert bool(restored["hazardAlerts"][0].get("responseCompletedAt")) == (not additional_step)


@pytest.mark.asyncio
async def test_decline_does_not_remove_offer_for_other_volunteers(response_app):
    main, _, client, actor = response_app
    alert = seed_response(main)
    await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                      headers={"Idempotency-Key": "send"})
    task_id = main.S["tasks"][0]["id"]
    as_actor(actor, "volunteer-1", "volunteer")
    assert (await client.post(f"/api/v1/tasks/{task_id}/transitions",
                              json={"status": "declined"})).status_code == 200
    assert (await client.get("/api/v1/my/tasks")).json() == []
    as_actor(actor, "volunteer-2", "volunteer")
    assert (await client.get("/api/v1/my/tasks")).json()[0]["status"] == "offered"
    await client.post(f"/api/v1/tasks/{task_id}/transitions", json={"status": "declined"})
    assert alert["responsePlan"][0]["status"] == "awaiting_approval"


@pytest.mark.asyncio
async def test_send_requires_accepted_volunteers_and_a_citizen_recipient(response_app):
    main, _, client, _ = response_app
    seed_response(main)
    main.S["volunteers"][0]["available"] = main.S["volunteers"][1]["available"] = False
    response = await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                                 headers={"Idempotency-Key": "no-volunteers"})
    assert response.status_code == 409
    assert not main.S["tasks"]
    main.S["volunteers"][0]["available"] = True
    main.S["reports"].clear()
    main.S["checkins"].clear()
    response = await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                                 headers={"Idempotency-Key": "no-citizens"})
    assert response.status_code == 409
    assert "Register a demo citizen" in response.json()["detail"]
    assert not main.S["tasks"]


@pytest.mark.asyncio
async def test_saved_simulator_inputs_are_predicted_and_updates_refresh_outlook(response_app):
    main, _, client, _ = response_app
    main.S["hazardSimInputs"]["kochi"] = {
        "cityId": "kochi", "rain24Mm": 150, "floodRiskPct": 85,
        "reservoirFillPct": 96, "updatedAt": main.now(),
    }
    assert not main.S["events"]
    assert await main.agent_tick([])
    alerts = [item for item in main.S["hazardAlerts"] if item["cityId"] == "kochi"]
    assert len(alerts) == 1
    assert alerts[0]["rainMm"] == 150
    assert main.S["hazardOutlook"]["kochi"]["rainMm"] == 150
    main.S["hazardSimInputs"]["kochi"].update(rain24Mm=70, floodRiskPct=30, reservoirFillPct=40)
    assert await main.agent_tick([])
    assert len([item for item in main.S["hazardAlerts"] if item["cityId"] == "kochi"]) == 1
    assert alerts[0]["severity"] == "medium"
    assert alerts[0]["rainMm"] == 70
    assert main.S["hazardOutlook"]["kochi"]["rainMm"] == 70
    main.S["hazardSimInputs"]["kochi"].update(rain24Mm=180, floodRiskPct=90, reservoirFillPct=95)
    response = await client.post("/api/v1/hazards/scan", json={
        "cityId": "kochi", "place": "Kochi", "rain24Mm": 1, "floodRiskPct": 0,
        "reservoirFillPct": 0,
    }, headers={"Idempotency-Key": "rescan"})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "existing"
    assert response.json()["rainMm"] == 180
    main.S["hazardSimInputs"]["kochi"].update(rain24Mm=0, floodRiskPct=0, reservoirFillPct=20)
    await main.agent_tick([])
    assert alerts[0]["severity"] == "low"
    assert alerts[0]["approvalStatus"] is None
    assert alerts[0]["recommendedActions"] == []


@pytest.mark.asyncio
async def test_blocked_task_can_be_reviewed_and_sent_again(response_app):
    main, _, client, actor = response_app
    alert = seed_response(main)
    await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                      headers={"Idempotency-Key": "first-send"})
    task_id = main.S["tasks"][0]["id"]
    as_actor(actor, "volunteer-1", "volunteer")
    await client.post(f"/api/v1/tasks/{task_id}/transitions", json={"status": "accepted"})
    response = await client.post(f"/api/v1/tasks/{task_id}/transitions",
                                 json={"status": "blocked", "note": "Simulated blocker"})
    assert response.status_code == 200, response.text
    assert alert["responsePlan"][0]["status"] == "awaiting_approval"
    as_actor(actor, "commander", "incident-commander")
    response = await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                                 headers={"Idempotency-Key": "reviewed-send"})
    assert response.status_code == 200, response.text
    assert len(main.S["tasks"]) == 2
    assert alert["responsePlan"][0]["taskId"] != task_id
    assert "volunteerName" not in alert["responsePlan"][0]


@pytest.mark.asyncio
async def test_existing_rescue_task_lifecycle_is_unchanged(response_app):
    main, _, client, actor = response_app
    main.S["tasks"].append({
        "id": "legacy-task", "planId": "legacy-plan", "planRevision": 1,
        "summary": "Legacy simulation", "status": "offered", "history": [],
    })
    main.S["volunteers"].append({
        "id": "V1", "subject": "volunteer-1", "displayName": "Volunteer 1",
        "status": "verified", "available": True,
    })
    as_actor(actor, "volunteer-1", "volunteer")
    for status in ("accepted", "on_site", "completed"):
        response = await client.post("/api/v1/tasks/legacy-task/transitions", json={"status": status})
        assert response.status_code == 200, response.text
    assert (await client.get("/api/v1/my/tasks")).json()[0]["assignee"] == "volunteer-1"


@pytest.mark.asyncio
async def test_sim_feed_forecast_window_matches_dashboard_outlook(response_app):
    main, _, _, _ = response_app
    candidate = {
        "cityId": "sim-source", "place": "Demo source", "rainMm": 140,
        "rainWindowHours": 48, "floodRiskPct": 85, "reservoirFillPct": 96,
        "severityRank": 3, "intensity": 140, "status": "extreme",
        "source": {"kind": "area"},
    }
    await main.agent_tick([candidate])
    assert main.S["hazardOutlook"]["sim-source"]["rainWindowHours"] == 48
    candidate.update(rainWindowHours=72, rainMm=160)
    await main.agent_tick([candidate])
    assert main.S["hazardOutlook"]["sim-source"]["rainWindowHours"] == 72
    assert main.S["hazardOutlook"]["sim-source"]["rainMm"] == 160


def test_completion_photo_size_limit():
    from app.main import TaskTransitionIn
    from pydantic import ValidationError

    image = b"\xff\xd8\xff" + b"\x00" * (2 * 1024 * 1024 - 3)
    photo = "data:image/jpeg;base64," + base64.b64encode(image).decode()
    assert TaskTransitionIn(status="completed", completionPhoto=photo).completionPhoto == photo
    oversized = "data:image/jpeg;base64," + base64.b64encode(image + b"\x00").decode()
    with pytest.raises(ValidationError, match="at most 2 MB"):
        TaskTransitionIn(status="completed", completionPhoto=oversized)


@pytest.mark.asyncio
async def test_alert_availability_is_separate_from_field_task_acceptance(response_app):
    main, _, client, actor = response_app
    alert = seed_response(main)
    main.S["volunteerRequests"].clear()
    main.S["volunteers"][0]["available"] = False
    main.S["volunteers"][1]["available"] = False
    main.S["volunteers"].append({
        "id": "V3", "subject": "volunteer-3", "displayName": "Unverified",
        "status": "pending", "available": True,
    })
    alert.update(approvalStatus="awaiting_approval", status="pending",
                 recommendedActions=[{"label": "Simulated rescue of 50 people", "detail": "Demo ward"}])
    response = await client.post("/api/v1/hazards/hazard-1/approve", json={},
                                 headers={"Idempotency-Key": "approve-alert"})
    assert response.status_code == 200, response.text
    assert len(main.S["volunteerRequests"]) == 2
    assert not main.S["tasks"]
    step_id = alert["responsePlan"][0]["id"]
    response = await client.post(f"/api/v1/hazards/hazard-1/plan/{step_id}/approve",
                                 headers={"Idempotency-Key": "too-soon"})
    assert response.status_code == 409

    as_actor(actor, "volunteer-1", "volunteer")
    requests = (await client.get("/api/v1/volunteer-requests/me")).json()
    assert requests[0]["canRespond"]
    request_id = requests[0]["id"]
    main.S["volunteerRequests"][0].update(status="expired", expiresAt="2020-01-01T00:00:00+00:00")
    response = await client.post(f"/api/v1/volunteer-requests/{request_id}/respond",
                                 json={"available": True}, headers={"Idempotency-Key": "late-yes"})
    assert response.status_code == 200, response.text
    assert main.S["volunteers"][0]["available"]
    assert (await client.get("/api/v1/volunteer-requests/me")).json()[0]["status"] == "accepted"
    assert not main.S["tasks"]

    as_actor(actor, "volunteer-2", "volunteer")
    request_id = (await client.get("/api/v1/volunteer-requests/me")).json()[0]["id"]
    response = await client.post(f"/api/v1/volunteer-requests/{request_id}/respond",
                                 json={"available": False}, headers={"Idempotency-Key": "no"})
    assert response.status_code == 200
    assert (await client.get("/api/v1/volunteer-requests/me")).json()[0]["status"] == "declined"
    as_actor(actor, "commander", "incident-commander")
    snapshot = (await client.get("/api/v1/state")).json()
    assert [item["status"] for item in snapshot["volunteerRequests"]] == ["accepted", "declined"]
    assert [item["volunteerName"] for item in snapshot["volunteerRequests"]] == ["Volunteer 1", "Volunteer 2"]
    response = await client.post(f"/api/v1/hazards/hazard-1/plan/{step_id}/approve",
                                 headers={"Idempotency-Key": "send-now"})
    assert response.status_code == 200, response.text
    task = main.S["tasks"][0]
    assert task["offeredTo"] == ["volunteer-1"]
    assert task["summary"] == "Simulated rescue of 50 people"
    assert task["detail"] == "Demo ward"
    as_actor(actor, "volunteer-2", "volunteer")
    assert (await client.get("/api/v1/my/tasks")).json() == []
    assert (await client.post(f"/api/v1/tasks/{task['id']}/transitions",
                              json={"status": "accepted"})).status_code == 403


def voice_note():
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * 800)
    return "data:audio/wav;base64," + base64.b64encode(data.getvalue()).decode()


@pytest.mark.asyncio
async def test_registered_volunteers_without_profiles_receive_alert_and_field_task(response_app):
    from app.accounts import UserAccount

    main, database, client, actor = response_app
    alert = seed_response(main)
    main.S["volunteers"].clear()
    main.S["volunteerRequests"].clear()
    async with database.sessions.begin() as session:
        for index, role in enumerate(("volunteer", "volunteer", "citizen", "staff"), 1):
            session.add(UserAccount(
                id=f"account-{index}", name=f"Demo {index}", phone=f"900000000{index}",
                email=f"account{index}@example.test", role=role,
                password_hash="test-only", created_at=main.now(),
            ))
    alert.update(approvalStatus="awaiting_approval", status="pending",
                 recommendedActions=[{"label": "Simulated rescue of 50 people", "detail": "Demo only"}])
    response = await client.post("/api/v1/hazards/hazard-1/approve", json={},
                                 headers={"Idempotency-Key": "account-alert"})
    assert response.status_code == 200, response.text
    assert len(main.S["volunteerRequests"]) == 2
    assert not main.S["volunteers"], "Invitations must not fabricate verified profiles"
    for index, available in ((1, True), (2, False)):
        as_actor(actor, f"account-{index}", "volunteer")
        request = (await client.get("/api/v1/volunteer-requests/me")).json()[0]
        response = await client.post(f"/api/v1/volunteer-requests/{request['id']}/respond",
                                     json={"available": available},
                                     headers={"Idempotency-Key": f"account-reply-{index}"})
        assert response.status_code == 200, response.text
    as_actor(actor, "commander", "incident-commander")
    step = alert["responsePlan"][0]
    response = await client.post(f"/api/v1/hazards/hazard-1/plan/{step['id']}/approve",
                                 headers={"Idempotency-Key": "account-field"})
    assert response.status_code == 200, response.text
    task = main.S["tasks"][0]
    assert task["offeredTo"] == ["account-1"]
    as_actor(actor, "account-1", "volunteer")
    assert (await client.get("/api/v1/my/tasks")).json()[0]["id"] == task["id"]
    for status in ("accepted", "on_site", "completed"):
        body = {"status": status}
        if status == "completed":
            body["completionVoice"] = voice_note()
        response = await client.post(f"/api/v1/tasks/{task['id']}/transitions", json=body)
        assert response.status_code == 200, response.text
    assert task["volunteerName"] == "Demo 1"
    assert task["status"] == "awaiting_confirmation"
    assert not main.S["volunteers"]
    main.S["tasks"].append({"id": "legacy", "status": "offered", "assignee": None})
    assert all(item["id"] != "legacy" for item in (await client.get("/api/v1/my/tasks")).json())
    assert (await client.post("/api/v1/tasks/legacy/transitions", json={"status": "accepted"})).status_code == 403


@pytest.mark.asyncio
async def test_registered_pending_profiles_are_eligible_but_withdrawn_profiles_are_not(response_app):
    from app.accounts import UserAccount

    main, database, _, _ = response_app
    seed_response(main)
    main.S["volunteers"][0]["status"] = "pending"
    main.S["volunteers"][1]["status"] = "withdrawn"
    async with database.sessions.begin() as session:
        for index in (1, 2):
            session.add(UserAccount(
                id=f"volunteer-{index}", phone=f"900000000{index}",
                email=f"pending{index}@example.test", role="volunteer",
                password_hash="test-only", created_at=main.now(),
            ))
    candidates = await main.hazard_volunteers(set())
    assert [item["subject"] for item in candidates] == ["volunteer-1"]
    assert candidates[0]["displayName"] == "Volunteer 1"
    assert await main.hazard_volunteers({"volunteer-1"}) == []
    assert main.S["volunteers"][0]["status"] == "pending"


@pytest.mark.asyncio
async def test_dispatch_without_reports_uses_demo_citizens_and_voice_completion(response_app):
    from app.accounts import UserAccount

    main, database, client, actor = response_app
    alert = seed_response(main)
    main.S["reports"].clear()
    main.S["checkins"].clear()
    async with database.sessions.begin() as session:
        for index, role in enumerate(("citizen", "citizen", "volunteer", "staff"), 1):
            session.add(UserAccount(
                id=f"registered-{index}", phone=f"900000000{index}",
                email=f"demo{index}@example.test", role=role,
                password_hash="not-a-real-password", created_at=main.now(),
            ))
    response = await client.post("/api/v1/hazards/hazard-1/plan/step-1/approve",
                                 headers={"Idempotency-Key": "send-no-reports"})
    assert response.status_code == 200, response.text
    task = main.S["tasks"][0]
    assert task["recipientSubjects"] == ["registered-1", "registered-2"]
    assert task["recipientScope"] == "registered_demo_citizens"
    as_actor(actor, "volunteer-1", "volunteer")
    for status in ("accepted", "on_site"):
        response = await client.post(f"/api/v1/tasks/{task['id']}/transitions", json={"status": status})
        assert response.status_code == 200, response.text
    voice = voice_note()
    response = await client.post(f"/api/v1/tasks/{task['id']}/transitions", json={
        "status": "completed", "completionVoice": voice,
        "note": "Simulated exercise finished.", "peopleAssisted": 50,
    })
    assert response.status_code == 200, response.text
    assert task["completionPhoto"] is None
    assert task["completionVoice"] == voice
    assert task["peopleAssisted"] == 50
    for subject in ("registered-1", "registered-2"):
        as_actor(actor, subject, "resident-reporter")
        update = (await client.get("/api/v1/my/response-updates")).json()[0]
        assert update["completionVoice"] == voice and update["canConfirm"]
        assert update["completionNote"] == "Simulated exercise finished."
        response = await client.post(f"/api/v1/tasks/{task['id']}/confirm")
        assert response.status_code == 200
    assert task["status"] == alert["responsePlan"][0]["status"] == "completed"
    assert all(ack["safe"] for ack in task["safetyAcknowledgements"])
    as_actor(actor, "commander", "incident-commander")
    snapshot = (await client.get("/api/v1/state")).json()
    assert "safetyAcknowledgements" not in snapshot["tasks"][0]
    assert snapshot["tasks"][0]["confirmationCount"] == 2
    assert (await database.load_state())["tasks"][0]["completionVoice"] == voice


def test_invalid_and_oversized_voice_notes_are_rejected():
    from app.main import TaskTransitionIn
    from pydantic import ValidationError

    assert TaskTransitionIn(status="completed", completionVoice=voice_note()).completionVoice
    at_limit = "data:audio/webm;base64," + base64.b64encode(
        b"\x1a\x45\xdf\xa3" + b"\x00" * (2 * 1024 * 1024 - 4)
    ).decode()
    assert TaskTransitionIn(status="completed", completionVoice=at_limit).completionVoice == at_limit
    for value in (
        "data:audio/wav;base64,invalid",
        "data:text/html;base64,UklGRg==",
        "data:audio/wav;base64," + base64.b64encode(b"not audio").decode(),
        "data:audio/webm;base64," + base64.b64encode(b"\x1a\x45\xdf\xa3" + b"\x00" * (2 * 1024 * 1024)).decode(),
    ):
        with pytest.raises(ValidationError):
            TaskTransitionIn(status="completed", completionVoice=value)
