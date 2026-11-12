"""Copy a stopped SQLite database into an empty PostgreSQL target, verifying every row."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import socket
import sys

from sqlalchemy import JSON, func, select, text

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))


async def migrate(source: Path, config_path: Path, refresh: bool = False) -> None:
    for port in (8000, 5173):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError("Stop the ASHRAAY stack and extension agents before migrating. A live application port is still open.")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    os.environ["DATABASE_URL"] = config["databaseUrl"]
    from app.database import Base, engine, install_agent_triggers

    if not source.is_file():
        raise RuntimeError(f"Source SQLite database not found: {source}")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = source.with_name(f"{source.stem}-before-postgres-{timestamp}.db")
    with sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True) as original:
        with sqlite3.connect(backup) as snapshot:
            original.backup(snapshot)
    counts = {}
    try:
        with sqlite3.connect(backup) as sqlite:
            sqlite.row_factory = sqlite3.Row
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
                if refresh:
                    previous = json.loads((ROOT / ".local-data" / "postgres-migration.json").read_text(encoding="utf-8"))
                    with sqlite3.connect(previous["backup"]) as prior:
                        prior.row_factory = sqlite3.Row
                        for table in Base.metadata.sorted_tables:
                            old_rows = [dict(row) for row in prior.execute(f'SELECT * FROM "{table.name}"')]
                            for row in old_rows:
                                for column in table.columns:
                                    if isinstance(column.type, JSON) and row[column.name] is not None:
                                        row[column.name] = json.loads(row[column.name])
                            current = [dict(row) for row in (await connection.execute(select(table))).mappings()]
                            keys = [column.name for column in table.primary_key]
                            sort_key = lambda row: tuple(str(row[key]) for key in keys)
                            if sorted(old_rows, key=sort_key) != sorted(current, key=sort_key):
                                raise RuntimeError(f"Target {table.name} changed since migration. Refresh refused to prevent data loss.")
                    for table in reversed(Base.metadata.sorted_tables):
                        await connection.execute(table.delete())
                for table in Base.metadata.sorted_tables:
                    count = await connection.scalar(select(func.count()).select_from(table))
                    if count:
                        raise RuntimeError(f"Target table {table.name} is not empty. Migration aborted; no target rows changed.")
                # Disable fanout during historical copy; restore it in the same transaction afterward.
                await connection.execute(text("DROP TRIGGER IF EXISTS trg_outbox_to_agent_inbox ON outbox_event"))
                await connection.execute(text("DROP TRIGGER IF EXISTS trg_message_to_agent_inbox ON agent_message"))
                for table in Base.metadata.sorted_tables:
                    rows = [dict(row) for row in sqlite.execute(f'SELECT * FROM "{table.name}"')]
                    for row in rows:
                        for column in table.columns:
                            if isinstance(column.type, JSON) and row[column.name] is not None:
                                row[column.name] = json.loads(row[column.name])
                    if rows:
                        await connection.execute(table.insert(), rows)
                    copied = [dict(row) for row in (await connection.execute(select(table))).mappings()]
                    primary_keys = [column.name for column in table.primary_key]
                    order = lambda row: tuple(str(row[key]) for key in primary_keys)
                    if sorted(rows, key=order) != sorted(copied, key=order):
                        raise RuntimeError(f"Row verification failed for {table.name}; transaction rolled back.")
                    counts[table.name] = len(rows)
                for table_name, column in (("agent_inbox", "id"), ("agent_message", "seq")):
                    last = sqlite.execute("SELECT seq FROM sqlite_sequence WHERE name=?", (table_name,)).fetchone()
                    sequence = int(last[0]) if last else 0
                    maximum = await connection.scalar(text(f'SELECT COALESCE(MAX({column}),0) FROM {table_name}'))
                    value = max(sequence, maximum)
                    await connection.execute(text(
                        "SELECT setval(pg_get_serial_sequence(:table, :column), :value, :called)"
                    ), {"table": table_name, "column": column, "value": max(1, value), "called": value > 0})
                await connection.run_sync(install_agent_triggers)
    finally:
        await engine.dispose()
    report = {"backup": str(backup), "verifiedRows": counts, "migratedAt": timestamp}
    (ROOT / ".local-data" / "postgres-migration.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Migrated and compared every row across {len(counts)} tables. SQLite backup: {backup}")
    print(json.dumps(counts))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".local-data" / "test.db")
    parser.add_argument("--config", type=Path, default=ROOT / ".local-data" / "postgres.json")
    parser.add_argument("--refresh", action="store_true", help="Replace only an untouched previous migration snapshot after verifying every target row.")
    args = parser.parse_args()
    asyncio.run(migrate(args.source.resolve(), args.config.resolve(), args.refresh))
