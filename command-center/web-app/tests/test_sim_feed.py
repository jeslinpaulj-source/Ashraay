from app.sim_feed import simulator_signals


def area(area_id, name, district, rain_today, rain_tomorrow, tomorrow_status):
    return {
        "id": area_id,
        "name": name,
        "district": district,
        "state": "Test State",
        "lat": 12.0,
        "lon": 77.0,
        "days": [
            {"rain_mm": rain_today, "status": "normal"},
            {"rain_mm": rain_tomorrow, "status": tomorrow_status},
        ],
    }


def test_simulator_signals_selects_highest_risk_source_without_city_coordinates():
    snapshot = {
        "areas": [
            area("near", "Near Ward", "Near District", 1, 2, "normal"),
            area("far", "Far Ward", "Far District", 1, 140, "extreme"),
        ],
        "stations": [],
        "reservoirs": [
            {"id": "dam", "name": "Full Dam", "district": "Dam District", "state": "Test State",
             "lat": 20.0, "lon": 80.0, "storage_pct": 99},
        ],
    }

    result = simulator_signals(snapshot)

    assert result["source"]["id"] == "far"
    assert result["place"].startswith("Far Ward")
    assert result["rainMm"] == 140
    assert result["rainWindowHours"] == 48
    assert result["reservoirFillPct"] == 0
    assert result["sourceCounts"] == {"areas": 2, "stations": 0, "reservoirs": 1}


def test_simulator_signals_do_not_combine_rain_and_reservoir_from_different_sources():
    snapshot = {
        "areas": [area("rain", "Rain Ward", "Rain District", 80, 80, "severe")],
        "stations": [],
        "reservoirs": [
            {"id": "dam", "name": "Full Dam", "district": "Dam District", "state": "Test State",
             "lat": 20.0, "lon": 80.0, "storage_pct": 99},
        ],
    }

    result = simulator_signals(snapshot)

    assert result["source"]["kind"] == "area"
    assert result["rainMm"] == 80
    assert result["reservoirFillPct"] == 0