from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy import BigInteger, Boolean, Index, Integer, JSON, String, Text, UniqueConstraint, delete, event, func, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

logger = logging.getLogger(__name__)

AGENTS = ("a1", "a2", "a3")
# Event types come from outbox_event.event_type, i.e. the CloudEvents "type" attribute.
AGENT_SUBSCRIPTIONS = (
    ("a1", "org.ashraay.observation.received.v1"),
    ("a3", "org.ashraay.review.decided.v1"),
    ("a3", "org.ashraay.forecast.ingested.v1"),
    ("a3", "org.ashraay.consent.withdrawn.v1"),
)
LIVE_HEARTBEAT_SECONDS = 30


class Base(DeclarativeBase):
    pass


class DemoState(Base):
    __tablename__ = "demo_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=False
    )


class OutboxEvent(Base):
    __tablename__ = "outbox_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    trace_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[str] = mapped_column(String(40), nullable=False)
    published_at: Mapped[str | None] = mapped_column(String(40))
    last_error: Mapped[str | None] = mapped_column(String(500))


class InboxEvent(Base):
    __tablename__ = "inbox_event"

    consumer: Mapped[str] = mapped_column(String(120), primary_key=True)
    event_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    processed_at: Mapped[str] = mapped_column(String(40), nullable=False)


class AgentMessage(Base):
    """Human-readable agent communication log; text is always English prose."""

    __tablename__ = "agent_message"
    __table_args__ = {"sqlite_autoincrement": True}

    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)
    conversation_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    in_reply_to: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[str] = mapped_column(String(40), nullable=False)
    from_agent: Mapped[str] = mapped_column(String(32), nullable=False)
    to_agent: Mapped[str | None] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    hop: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON().with_variant(JSONB, "postgresql"))
    run_id: Mapped[str | None] = mapped_column(String(36))


class AgentInbox(Base):
    """Per-agent work queue filled by database triggers; (agent, ref) is the dedupe key."""

    __tablename__ = "agent_inbox"
    __table_args__ = (
        UniqueConstraint("agent", "ref_kind", "ref_id", name="uq_agent_inbox_ref"),
        Index("ix_agent_inbox_ready", "agent", "status", "available_at_ms"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent: Mapped[str] = mapped_column(String(32), nullable=False)
    ref_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    ref_id: Mapped[str] = mapped_column(String(64), nullable=False)
    event_type: Mapped[str] = mapped_column(String(160), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    claimed_at_ms: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[str] = mapped_column(String(40), nullable=False)
    completed_at: Mapped[str | None] = mapped_column(String(40))
    last_error: Mapped[str | None] = mapped_column(String(500))


class AgentSubscription(Base):
    __tablename__ = "agent_subscription"

    agent: Mapped[str] = mapped_column(String(32), primary_key=True)
    event_type: Mapped[str] = mapped_column(String(160), primary_key=True)


class AgentHeartbeat(Base):
    __tablename__ = "agent_heartbeat"

    agent: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    llm_mode: Mapped[str] = mapped_column(String(80), nullable=False, default="rules")
    host: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    started_at: Mapped[str] = mapped_column(String(40), nullable=False)
    last_seen_at: Mapped[str] = mapped_column(String(40), nullable=False)
    last_seen_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    detail: Mapped[str | None] = mapped_column(String(500))


class AgentRun(Base):
    __tablename__ = "agent_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    agent: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    trigger: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    llm_used: Mapped[str] = mapped_column(String(80), nullable=False, default="rules")
    started_at: Mapped[str] = mapped_column(String(40), nullable=False)
    finished_at: Mapped[str | None] = mapped_column(String(40))
    summary: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(String(500))


class AgentState(Base):
    __tablename__ = "agent_state"

    agent: Mapped[str] = mapped_column(String(32), primary_key=True)
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON().with_variant(JSONB, "postgresql"), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(40), nullable=False)


class AgentLlmSettings(Base):
    """Single row holding the GitHub Copilot SDK settings used by the Hazard Prediction & Volunteer
    Dispatch agents (A1/A2/A3) for judgement. The GitHub token must be a gho_/ghu_/github_pat_ token
    for an account with an active Copilot subscription; it is never returned by the API."""
    __tablename__ = "agent_llm_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    llm_mode: Mapped[str] = mapped_column(String(32), nullable=False, default="copilot-sdk")
    llm_model: Mapped[str] = mapped_column(String(200), nullable=False, default="n/a")
    github_token: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    updated_at: Mapped[str] = mapped_column(String(40), nullable=False, default="")


class AgentRunControl(Base):
    """Single row: whether the standalone agents process may claim and process work right now. Defaults
    to disabled, so a freshly started agents process stays idle until a human starts it."""
    __tablename__ = "agent_run_control"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[str] = mapped_column(String(40), nullable=False, default="")


database_url = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://ashraay:ashraay_demo@localhost:5432/ashraay"
)
if not os.getenv("DATABASE_URL"):
    raise RuntimeError("DATABASE_URL is required. Use the ASHRAAY launcher or configure an explicit PostgreSQL connection.")
# Windows "set VAR=value && next" keeps the space before "&&"; strip stray whitespace so the
# database name doesn't become e.g. "ashraay " (InvalidCatalogNameError).
database_url = database_url.strip()
engine = create_async_engine(database_url, pool_pre_ping=True)


if database_url.startswith("sqlite"):
    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite(dbapi_connection, _record):
        # Agents in another process write to this file; WAL plus a busy timeout avoids spurious lock errors.
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


sessions = async_sessionmaker(engine, expire_on_commit=False)

_FANOUT_SQL = (
    "DROP TRIGGER IF EXISTS trg_outbox_to_agent_inbox",
    """
    CREATE TRIGGER trg_outbox_to_agent_inbox AFTER INSERT ON outbox_event
    BEGIN
      INSERT OR IGNORE INTO agent_inbox
        (agent, ref_kind, ref_id, event_type, status, attempts, available_at_ms, created_at)
      SELECT agent, 'event', NEW.id, NEW.event_type, 'pending', 0,
             CAST(strftime('%s','now') AS INTEGER) * 1000, strftime('%Y-%m-%dT%H:%M:%SZ','now')
      FROM agent_subscription WHERE event_type = NEW.event_type;
    END
    """,
    "DROP TRIGGER IF EXISTS trg_message_to_agent_inbox",
    """
    CREATE TRIGGER trg_message_to_agent_inbox AFTER INSERT ON agent_message
    WHEN NEW.to_agent IN ('a1','a2','a3') AND NEW.kind IN ('query','response')
    BEGIN
      INSERT OR IGNORE INTO agent_inbox
        (agent, ref_kind, ref_id, event_type, status, attempts, available_at_ms, created_at)
      VALUES (NEW.to_agent, 'message', NEW.id, 'agent.message.' || NEW.kind, 'pending', 0,
              CAST(strftime('%s','now') AS INTEGER) * 1000, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    END
    """,
)


_POSTGRES_FANOUT_SQL = (
    """CREATE OR REPLACE FUNCTION ashraay_outbox_fanout() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO agent_inbox
        (agent, ref_kind, ref_id, event_type, status, attempts, available_at_ms, created_at)
      SELECT agent, 'event', NEW.id, NEW.event_type, 'pending', 0,
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM agent_subscription WHERE event_type = NEW.event_type
      ON CONFLICT (agent, ref_kind, ref_id) DO NOTHING;
      PERFORM pg_notify('ashraay_work', NEW.event_type);
      RETURN NEW;
    END $$""",
    "DROP TRIGGER IF EXISTS trg_outbox_to_agent_inbox ON outbox_event",
    """CREATE TRIGGER trg_outbox_to_agent_inbox AFTER INSERT ON outbox_event
       FOR EACH ROW EXECUTE FUNCTION ashraay_outbox_fanout()""",
    """CREATE OR REPLACE FUNCTION ashraay_message_fanout() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.to_agent IN ('a1','a2','a3') AND NEW.kind IN ('query','response') THEN
        INSERT INTO agent_inbox
          (agent, ref_kind, ref_id, event_type, status, attempts, available_at_ms, created_at)
        VALUES (NEW.to_agent, 'message', NEW.id, 'agent.message.' || NEW.kind, 'pending', 0,
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ON CONFLICT (agent, ref_kind, ref_id) DO NOTHING;
        PERFORM pg_notify('ashraay_work', NEW.to_agent);
      END IF;
      RETURN NEW;
    END $$""",
    "DROP TRIGGER IF EXISTS trg_message_to_agent_inbox ON agent_message",
    """CREATE TRIGGER trg_message_to_agent_inbox AFTER INSERT ON agent_message
       FOR EACH ROW EXECUTE FUNCTION ashraay_message_fanout()""",
)


def install_agent_triggers(connection) -> bool:
    """Install transactional, deduplicated work queues for the configured database."""
    if connection.dialect.name == "postgresql":
        for agent, event_type in AGENT_SUBSCRIPTIONS:
            connection.execute(text(
                "INSERT INTO agent_subscription(agent, event_type) VALUES (:agent, :event_type) "
                "ON CONFLICT DO NOTHING"
            ), {"agent": agent, "event_type": event_type})
        for statement in _POSTGRES_FANOUT_SQL:
            connection.exec_driver_sql(statement)
        return True
    if connection.dialect.name != "sqlite":
        raise RuntimeError("ASHRAAY supports PostgreSQL and SQLite test databases only.")
    for agent, event_type in AGENT_SUBSCRIPTIONS:
        connection.exec_driver_sql(
            "INSERT OR IGNORE INTO agent_subscription(agent, event_type) VALUES (?, ?)",
            (agent, event_type),
        )
    for statement in _FANOUT_SQL:
        connection.exec_driver_sql(statement)
    return True


async def load_state() -> dict[str, Any]:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        if connection.dialect.name == "postgresql":
            await connection.execute(text(
                "ALTER TABLE agent_inbox ALTER COLUMN available_at_ms TYPE BIGINT, "
                "ALTER COLUMN claimed_at_ms TYPE BIGINT"
            ))
            await connection.execute(text("ALTER TABLE agent_heartbeat ALTER COLUMN last_seen_ms TYPE BIGINT"))
            # create_all does not add columns to existing tables.
            await connection.execute(text("ALTER TABLE user_account ADD COLUMN IF NOT EXISTS name VARCHAR(80)"))
            await connection.execute(text("ALTER TABLE user_account ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION"))
            await connection.execute(text("ALTER TABLE user_account ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION"))
        await connection.run_sync(install_agent_triggers)
    async with sessions() as session:
        stored = await session.scalar(select(DemoState).where(DemoState.id == 1))
        if stored is None:
            empty = {
                "agents": {
                    agent: {"status": "stopped", "mode": "rules", "lastRun": None}
                    for agent in ("a1", "a2", "a3")
                },
                "forecasts": [],
                "reports": [],
                "checkins": [],
                "incidents": [],
                "reviews": [],
                "plans": [],
                "tasks": [],
                "deliveries": [],
                "events": [],
                "audit": [],
            }
            session.add(DemoState(id=1, version=1, payload=empty))
            await session.commit()
            return empty
        return stored.payload


async def save_state(payload: dict[str, Any], reset_outbox: bool = False) -> None:
    async with sessions.begin() as session:
        retained_state = {**payload, "events": payload.get("events", [])[-500:]}
        if reset_outbox:
            await session.execute(delete(InboxEvent))
            await session.execute(delete(OutboxEvent))
            await session.execute(delete(AgentInbox))
            await session.execute(delete(AgentMessage))
        stored = await session.scalar(
            select(DemoState).where(DemoState.id == 1).with_for_update()
        )
        if stored is None:
            session.add(DemoState(id=1, version=1, payload=retained_state))
        else:
            stored.payload = retained_state
            stored.version += 1
        event_ids = [item["id"] for item in payload.get("events", [])]
        if event_ids:
            known_ids = set(
                (
                    await session.scalars(
                        select(OutboxEvent.id).where(OutboxEvent.id.in_(event_ids))
                    )
                ).all()
            )
            for event in payload.get("events", []):
                if event["id"] in known_ids:
                    continue
                session.add(
                    OutboxEvent(
                        id=event["id"],
                        event_type=event["type"],
                        trace_id=event["traceid"],
                        payload=event,
                        status="pending",
                        attempts=0,
                        created_at=event["time"],
                    )
                )


async def outbox_snapshot() -> dict[str, Any]:
    async with sessions() as session:
        counts = dict(
            (await session.execute(
                select(OutboxEvent.status, func.count()).group_by(OutboxEvent.status)
            )).all()
        )
        rows = list(
            (
                await session.scalars(
                    select(OutboxEvent).order_by(OutboxEvent.created_at.desc()).limit(500)
                )
            ).all()
        )
        return {
            "counts": {
                status: counts.get(status, 0)
                for status in ("pending", "published", "dead_letter")
            },
            "events": [
                {
                    "id": row.id,
                    "type": row.event_type,
                    "traceId": row.trace_id,
                    "status": row.status,
                    "attempts": row.attempts,
                    "createdAt": row.created_at,
                    "publishedAt": row.published_at,
                    "lastError": row.last_error,
                }
                for row in rows
            ],
        }


async def dispatch_outbox(limit: int, consumer: str, processed_at: str) -> dict[str, Any]:
    async with sessions.begin() as session:
        rows = list(
            (
                await session.scalars(
                    select(OutboxEvent)
                    .where(OutboxEvent.status == "pending")
                    .order_by(OutboxEvent.created_at, OutboxEvent.id)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        dispatched = 0
        duplicates = 0
        for row in rows:
            prior = await session.get(InboxEvent, (consumer, row.id))
            if prior is None:
                session.add(
                    InboxEvent(consumer=consumer, event_id=row.id, processed_at=processed_at)
                )
                dispatched += 1
            else:
                duplicates += 1
            row.status = "published"
            row.published_at = processed_at
            row.last_error = None
        remaining = await session.scalar(
            select(func.count()).select_from(OutboxEvent).where(OutboxEvent.status == "pending")
        )
        return {
            "dispatched": dispatched,
            "duplicates": duplicates,
            "remaining": remaining or 0,
        }


async def fail_outbox_event(event_id: str, error: str, max_attempts: int = 5) -> dict[str, Any] | None:
    async with sessions.begin() as session:
        row = await session.get(OutboxEvent, event_id, with_for_update=True)
        if row is None:
            return None
        if row.status != "pending":
            return {
                "id": row.id,
                "status": row.status,
                "attempts": row.attempts,
                "lastError": row.last_error,
            }
        row.attempts += 1
        row.last_error = error[:500]
        if row.attempts >= max_attempts:
            row.status = "dead_letter"
        return {
            "id": row.id,
            "status": row.status,
            "attempts": row.attempts,
            "lastError": row.last_error,
        }


async def replay_outbox_event(event_id: str) -> dict[str, Any] | None:
    async with sessions.begin() as session:
        row = await session.get(OutboxEvent, event_id, with_for_update=True)
        if row is None:
            return None
        if row.status != "dead_letter":
            return {
                "id": row.id,
                "status": row.status,
                "attempts": row.attempts,
            }
        prior = await session.get(InboxEvent, ("simulator-observer", event_id))
        if prior is not None:
            row.status = "published"
            return {"id": row.id, "status": row.status, "attempts": row.attempts}
        row.status = "pending"
        row.last_error = None
        return {"id": row.id, "status": row.status, "attempts": row.attempts}


async def dispose() -> None:
    await engine.dispose()


async def get_llm_settings() -> dict[str, Any]:
    async with sessions() as session:
        row = await session.get(AgentLlmSettings, 1)
        if row is None:
            return {"llmMode": "copilot-sdk", "llmModel": "n/a", "hasToken": False}
        return {"llmMode": row.llm_mode, "llmModel": row.llm_model, "hasToken": bool(row.github_token)}


async def get_llm_settings_with_token() -> dict[str, Any]:
    """Internal-only: includes the raw token, so the Copilot SDK can authenticate with it.

    Never expose this over the API - use get_llm_settings() for anything client-facing."""
    async with sessions() as session:
        row = await session.get(AgentLlmSettings, 1)
        if row is None:
            return {"llmMode": "copilot-sdk", "llmModel": "n/a", "githubToken": ""}
        return {"llmMode": row.llm_mode, "llmModel": row.llm_model, "githubToken": row.github_token}


async def set_llm_settings(llm_mode: str, llm_model: str, github_token: str | None, updated_at: str) -> dict[str, Any]:
    async with sessions.begin() as session:
        row = await session.get(AgentLlmSettings, 1, with_for_update=True)
        if row is None:
            row = AgentLlmSettings(id=1, llm_mode=llm_mode, llm_model=llm_model, github_token="", updated_at=updated_at)
            session.add(row)
        row.llm_mode = llm_mode
        row.llm_model = llm_model
        if github_token:
            row.github_token = github_token
        row.updated_at = updated_at
        has_token = bool(row.github_token)
    return {"llmMode": llm_mode, "llmModel": llm_model, "hasToken": has_token}


async def get_run_control() -> dict[str, Any]:
    async with sessions() as session:
        row = await session.get(AgentRunControl, 1)
        return {"enabled": bool(row.enabled) if row else False}


async def set_run_control(enabled: bool, updated_at: str) -> dict[str, Any]:
    async with sessions.begin() as session:
        row = await session.get(AgentRunControl, 1, with_for_update=True)
        if row is None:
            session.add(AgentRunControl(id=1, enabled=enabled, updated_at=updated_at))
        else:
            row.enabled = enabled
            row.updated_at = updated_at
    return {"enabled": enabled}


async def agent_log_snapshot(limit: int, include_content: bool = True) -> list[dict[str, Any]]:
    async with sessions() as session:
        rows = list(
            (
                await session.scalars(
                    select(AgentMessage).order_by(AgentMessage.seq.desc()).limit(limit)
                )
            ).all()
        )
    return [
        {
            "seq": row.seq,
            "id": row.id,
            "conversationId": row.conversation_id,
            "inReplyTo": row.in_reply_to,
            "time": row.created_at,
            "from": row.from_agent,
            "to": row.to_agent,
            "kind": row.kind,
            "text": row.text if include_content else "[content hidden for this role]",
        }
        for row in reversed(rows)
    ]


async def agent_status_snapshot(now_ms: int) -> list[dict[str, Any]]:
    async with sessions() as session:
        beats = {
            row.agent: row for row in (await session.scalars(select(AgentHeartbeat))).all()
        }
        pending = dict(
            (
                await session.execute(
                    select(AgentInbox.agent, func.count())
                    .where(AgentInbox.status.in_(("pending", "processing")))
                    .group_by(AgentInbox.agent)
                )
            ).all()
        )
        dead = dict(
            (
                await session.execute(
                    select(AgentInbox.agent, func.count())
                    .where(AgentInbox.status == "dead_letter")
                    .group_by(AgentInbox.agent)
                )
            ).all()
        )
    result = []
    for agent in AGENTS:
        beat = beats.get(agent)
        age = None if beat is None else max(0, (now_ms - beat.last_seen_ms) // 1000)
        result.append(
            {
                "agent": agent,
                "live": bool(beat and age is not None and age <= LIVE_HEARTBEAT_SECONDS and beat.status == "running"),
                "status": beat.status if beat else "never_started",
                "llm": beat.llm_mode if beat else None,
                "host": beat.host if beat else None,
                "lastSeenSecondsAgo": age,
                "pendingWork": pending.get(agent, 0),
                "deadLetters": dead.get(agent, 0),
            }
        )
    return result
