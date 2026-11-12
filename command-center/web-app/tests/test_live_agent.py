from app import live_agent as la


def test_active_volunteers_ignore_location():
    vols = [
        {"id": "V1", "status": "verified", "available": True},                      # no location at all
        {"id": "V2", "status": "verified", "available": True, "area": "Far away"},
        {"id": "V3", "status": "pending", "available": True},
        {"id": "V4", "status": "verified", "available": False},
    ]
    assert [v["id"] for v in la.active_volunteers(vols)] == ["V1", "V2"]


def test_citizen_signals_use_latest_checkin_per_person_and_new_reports():
    state = {
        "checkins": [
            {"owner": "a", "status": "safe", "time": "1"},
            {"owner": "a", "status": "need_help", "time": "2"},
            {"owner": "b", "status": "at_risk", "time": "1"},
        ],
        "reports": [{"status": "received", "people": 4}],
        "incidents": [],
    }
    s = la.citizen_signals(state)
    assert (s["needHelp"], s["atRisk"], s["openIncidents"], s["peopleReported"]) == (1, 1, 1, 4)
    assert la.citizen_severity(s) == "medium"
    assert la.citizen_recommended_actions(s)[0]["label"].startswith("Send a rescue team")


def test_rules_fallback_gives_recommendations():
    actions = la.rule_recommended_actions("Pune", "high", 180, 97)
    assert any(a["icon"] == "dam" for a in actions) and len(actions) >= 3
    assert la.rule_confidence(180, 97, 85, "high") >= 0.8
