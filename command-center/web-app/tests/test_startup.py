from unittest.mock import AsyncMock

import pytest
from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
@pytest.mark.parametrize("reset_on_start", [True, False])
@pytest.mark.parametrize("existing_state", [True, False])
async def test_startup_initializes_database_before_reset_or_restore(
    monkeypatch, tmp_path, reset_on_start, existing_state
):
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    from app import database, main

    engine = create_async_engine(
        "sqlite+aiosqlite:///" + (tmp_path / "startup.db").as_posix()
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "sessions", sessions)
    monkeypatch.setattr(main, "RESET_ON_START", reset_on_start)
    monkeypatch.setattr(main, "SEED_HAZARD_DEMO", False)
    monkeypatch.setitem(main.auto_run, "running", False)
    monkeypatch.setattr(main, "reliability_worker", AsyncMock())
    monkeypatch.setattr(main, "volunteer_escalation_worker", AsyncMock())
    monkeypatch.setattr(main, "simulation_agent_worker", AsyncMock())
    monkeypatch.setattr(main.copilot_agent, "shutdown", AsyncMock())

    try:
        if existing_state:
            state = await database.load_state()
            state["reports"] = [{"id": "saved-report"}]
            await database.save_state(state)

        async with main.lifespan(main.app):
            async with engine.connect() as connection:
                tables = await connection.run_sync(
                    lambda conn: inspect(conn).get_table_names()
                )
            assert set(database.Base.metadata.tables).issubset(tables)
            expected_reports = (
                [{"id": "saved-report"}] if existing_state and not reset_on_start else []
            )
            assert main.S["reports"] == expected_reports

        async with sessions() as session:
            stored = await session.scalar(
                select(database.DemoState).where(database.DemoState.id == 1)
            )
            assert stored is not None
            assert stored.payload["reports"] == expected_reports
    finally:
        await engine.dispose()
