"""Provision/start/stop the project-owned, password-protected loopback PostgreSQL cluster."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from datetime import datetime, timezone
from urllib.request import urlretrieve
import zipfile
from uuid import uuid4
from urllib.parse import urlsplit

import asyncpg

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".local-data" / "postgres.json"
DATA = ROOT / ".local-data" / "postgres"
BIN = ROOT / "node_modules" / "@embedded-postgres" / "windows-x64" / "native" / "bin"
PORT = 55900
CLIENT_BIN = ROOT / ".local-data" / "postgres-tools"
CLIENT_ARCHIVE = "https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip"


def private_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    identity = subprocess.check_output(["whoami"], text=True).strip()
    subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"],
                   check=True, stdout=subprocess.DEVNULL)


def run(tool: str, *args: str) -> None:
    environment = {**os.environ, "PATH": str(BIN) + os.pathsep + os.environ["PATH"]}
    executable = BIN / f"{tool}.exe"
    if not executable.is_file():
        executable = CLIENT_BIN / f"{tool}.exe"
    if not executable.is_file():
        raise RuntimeError("PostgreSQL client tools are missing. Run scripts\\local-postgres.py tools first.")
    if tool == "pg_ctl" and "start" in args:
        # A detached server must not retain the launcher's stdout pipe on Windows.
        subprocess.run([str(executable), *args], env=environment, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.run([str(executable), *args], env=environment, check=True)


def install_client_tools() -> None:
    CLIENT_BIN.mkdir(parents=True, exist_ok=True)
    print("Downloading official EDB PostgreSQL 18.6 Windows archive (about 367 MB); installing only client executables.", flush=True)
    with tempfile.TemporaryDirectory(prefix="ashraay-pg-tools-") as directory:
        archive = Path(directory) / "postgres.zip"
        urlretrieve(CLIENT_ARCHIVE, archive)
        with zipfile.ZipFile(archive) as files:
            for name in ("pg_dump.exe", "pg_restore.exe", "psql.exe"):
                (CLIENT_BIN / name).write_bytes(files.read(f"pgsql/bin/{name}"))
    run("pg_dump", "--version")


async def provision(config: dict) -> None:
    admin = await asyncpg.connect(config["adminUrl"])
    try:
        for name, password in (("app_user", config["apiPassword"]), ("agent", config["agentPassword"])):
            if not await admin.fetchval("SELECT 1 FROM pg_roles WHERE rolname=$1", name):
                # Identifiers are fixed and passwords are generated URL-safe ASCII, not user input.
                await admin.execute(f"CREATE ROLE {name} LOGIN PASSWORD '{password}'")
        if not await admin.fetchval("SELECT 1 FROM pg_database WHERE datname='ashraay'"):
            await admin.execute("CREATE DATABASE ashraay OWNER app_user")
    finally:
        await admin.close()
    connection = await asyncpg.connect(config["adminUrl"].rsplit("/", 1)[0] + "/ashraay")
    try:
        await connection.execute("""
            REVOKE CREATE ON SCHEMA public FROM PUBLIC;
            GRANT USAGE, CREATE ON SCHEMA public TO app_user;
            GRANT USAGE ON SCHEMA public TO agent;
            ALTER DEFAULT PRIVILEGES FOR ROLE app_user IN SCHEMA public
              GRANT SELECT ON TABLES TO agent;
        """)
    finally:
        await connection.close()


def reset_passwords(config: dict) -> dict:
    """Explicit local maintenance: rotate credentials without recreating the cluster."""
    if not (DATA / "PG_VERSION").is_file():
        raise RuntimeError("No initialized project cluster exists; refusing password recovery.")
    environment = {**os.environ, "PATH": str(BIN) + os.pathsep + os.environ["PATH"]}
    port = int(subprocess.check_output(
        [str(BIN / "postgres.exe"), "-D", str(DATA), "-C", "port"],
        env=environment, text=True,
    ).strip())
    passwords = [secrets.token_urlsafe(32) for _ in range(3)]
    recovered = {
        **config,
        "port": port,
        "adminUrl": f"postgresql://admin:{passwords[0]}@127.0.0.1:{port}/postgres",
        "databaseUrl": f"postgresql+asyncpg://app_user:{passwords[1]}@127.0.0.1:{port}/ashraay",
        "agentUrl": f"postgresql://agent:{passwords[2]}@127.0.0.1:{port}/ashraay",
        "apiPassword": passwords[1],
        "agentPassword": passwords[2],
    }
    recovery = CONFIG.with_name(f"postgres-recovery-{uuid4().hex}.json")
    private_file(recovery, json.dumps(recovered, indent=2))
    private_file(CONFIG.with_name(f"postgres-before-recovery-{uuid4().hex}.json"),
                 json.dumps(config, indent=2))
    process_status = subprocess.run(
        [str(BIN / "pg_ctl.exe"), "-D", str(DATA), "status"], capture_output=True,
    )
    if process_status.returncode == 0:
        run("pg_ctl", "-D", str(DATA), "-m", "fast", "-w", "stop")
    elif process_status.returncode != 3:
        raise RuntimeError("Cannot determine project cluster status; refusing password recovery.")
    statements = "\n".join(
        f"ALTER ROLE {role} WITH PASSWORD '{password}';"
        for role, password in zip(("admin", "app_user", "agent"), passwords)
    )
    result = subprocess.run(
        [str(BIN / "postgres.exe"), "--single", "-D", str(DATA), "postgres"],
        input=statements + "\n", text=True, capture_output=True, env=environment,
    )
    if result.returncode != 0 or any(
        marker in result.stderr for marker in ("ERROR:", "FATAL:", "PANIC:")
    ):
        raise RuntimeError(
            "Offline password recovery failed; the cluster remains stopped. "
            f"Recovery credentials are saved privately in {recovery}. "
            "Do not delete the database directory."
        )
    private_file(CONFIG, json.dumps(recovered, indent=2))
    print("Local credentials rotated and connection port synchronized; existing database data retained.")
    return recovered


def validate_endpoint(config: dict, actual_port: int) -> None:
    for key in ("adminUrl", "databaseUrl", "agentUrl"):
        target = urlsplit(config[key])
        if target.hostname != "127.0.0.1" or target.port != actual_port:
            raise RuntimeError(
                f"{key} does not match the project cluster endpoint 127.0.0.1:{actual_port}. "
                "Restore this cluster's original postgres.json, or use the explicit "
                "reset-passwords action for data-preserving local credential recovery."
            )


async def grant_agent_access(config: dict) -> None:
    connection = await asyncpg.connect(config["adminUrl"].rsplit("/", 1)[0] + "/ashraay")
    try:
        await connection.execute("""
            GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent;
            GRANT INSERT, UPDATE, DELETE ON agent_inbox, agent_message, agent_heartbeat,
              agent_run, agent_state TO agent;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent;
        """)
    finally:
        await connection.close()


async def status(config: dict) -> None:
    connection = await asyncpg.connect(config["agentUrl"], timeout=5)
    try:
        print(await connection.fetchval("SELECT version()"))
        print("Database:", await connection.fetchval("SELECT current_database()"))
        print("Endpoint: 127.0.0.1:", config["port"], sep="")
        print("Live agents:", await connection.fetchval(
            "SELECT count(*) FROM agent_heartbeat WHERE status='running' "
            "AND last_seen_ms > extract(epoch FROM clock_timestamp()) * 1000 - 30000"
        ))
        print("Stored reports:", await connection.fetchval(
            "SELECT jsonb_array_length(payload->'reports') FROM demo_state WHERE id=1"
        ))
    finally:
        await connection.close()


async def verify_backup(config: dict, backup: Path) -> None:
    if not backup.is_file():
        raise RuntimeError(f"Backup file does not exist: {backup}")
    name = "ashraay_restore_test_" + uuid4().hex
    admin = await asyncpg.connect(config["adminUrl"])
    created = False
    try:
        await admin.execute(f"CREATE DATABASE {name} OWNER app_user")
        created = True
        os.environ["PGPASSWORD"] = config["apiPassword"]
        run("pg_restore", "-h", "127.0.0.1", "-p", str(config["port"]), "-U", "app_user",
            "--exit-on-error", "--no-owner", "-d", name, str(backup))
        restored = await asyncpg.connect(config["databaseUrl"].replace("postgresql+asyncpg:", "postgresql:").rsplit("/", 1)[0] + "/" + name)
        try:
            tables = ("demo_state", "outbox_event", "inbox_event", "agent_inbox", "agent_message",
                      "agent_subscription", "agent_run", "agent_state", "agent_heartbeat")
            counts = {table: await restored.fetchval(f"SELECT count(*) FROM {table}") for table in tables}
            if counts["demo_state"] != 1 or counts["agent_subscription"] != 4:
                raise RuntimeError("Restored database is missing runtime state or subscriptions.")
            print("Backup restored successfully into a disposable database:", json.dumps(counts))
        finally:
            await restored.close()
    finally:
        if created:
            await admin.execute(f"DROP DATABASE {name} WITH (FORCE)")
        await admin.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop", "grant", "status", "shell", "backup", "tools", "verify-backup", "reset-passwords"])
    parser.add_argument("--backup", type=Path, help="Dump file to test in a uniquely named disposable database.")
    args = parser.parse_args()
    if not (BIN / "pg_ctl.exe").is_file():
        raise SystemExit("PostgreSQL binaries are missing. Run npm install in the project root.")
    if args.action == "tools":
        install_client_tools()
        return
    if args.action == "stop":
        if DATA.exists():
            result = subprocess.run([str(BIN / "pg_ctl.exe"), "-D", str(DATA), "status"], capture_output=True)
            if result.returncode == 0:
                run("pg_ctl", "-D", str(DATA), "-m", "fast", "-w", "stop")
            elif result.returncode == 3:
                print("Project PostgreSQL is already stopped.")
            else:
                raise RuntimeError("Cannot determine project PostgreSQL status; refusing to guess.")
        return
    if CONFIG.exists():
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
    else:
        if args.action != "start":
            raise SystemExit("Project PostgreSQL is not configured. Run the launcher first.")
        if DATA.exists():
            raise SystemExit("A cluster exists without its credentials file. Restore postgres.json; do not overwrite the cluster.")
        passwords = [secrets.token_urlsafe(32) for _ in range(3)]
        config = {
            "port": PORT, "adminUrl": f"postgresql://admin:{passwords[0]}@127.0.0.1:{PORT}/postgres",
            "databaseUrl": f"postgresql+asyncpg://app_user:{passwords[1]}@127.0.0.1:{PORT}/ashraay",
            "agentUrl": f"postgresql://agent:{passwords[2]}@127.0.0.1:{PORT}/ashraay",
            "apiPassword": passwords[1], "agentPassword": passwords[2],
        }
        private_file(CONFIG, json.dumps(config, indent=2))
    if args.action == "reset-passwords":
        config = reset_passwords(config)
    if args.action == "grant":
        asyncio.run(grant_agent_access(config))
        return
    if args.action == "status":
        asyncio.run(status(config))
        return
    if args.action == "shell":
        # psql.exe needs libpq.dll etc. from the embedded server's bin/, not just the client-tools folder.
        os.environ["PGPASSWORD"] = config["apiPassword"]
        run("psql", "-h", "127.0.0.1", "-p", str(config["port"]), "-U", "app_user", "-d", "ashraay")
        return
    if args.action == "verify-backup":
        if args.backup is None:
            raise SystemExit("Specify --backup with the dump to verify.")
        asyncio.run(verify_backup(config, args.backup.resolve()))
        return
    if args.action == "backup":
        directory = ROOT / ".local-data" / "backups"
        directory.mkdir(exist_ok=True)
        target = directory / f"ashraay-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.dump"
        os.environ["PGPASSWORD"] = config["apiPassword"]
        run("pg_dump", "-h", "127.0.0.1", "-p", str(config["port"]), "-U", "app_user",
            "-d", "ashraay", "-Fc", "-f", str(target))
        print("PostgreSQL backup:", target)
        return
    if not (DATA / "PG_VERSION").exists():
        with tempfile.TemporaryDirectory(prefix="ashraay-initdb-") as directory:
            password_file = Path(directory) / "password"
            password = config["adminUrl"].split(":", 2)[2].split("@", 1)[0]
            private_file(password_file, password)
            run("initdb", "-D", str(DATA), "-U", "admin", "--encoding=UTF8", "--locale=C",
                "--auth=scram-sha-256", "--pwfile", str(password_file))
        with (DATA / "postgresql.conf").open("a", encoding="utf-8") as file:
            file.write(f"\nlisten_addresses = '127.0.0.1'\nport = {config['port']}\n")
    actual_port = int(subprocess.check_output(
        [str(BIN / "postgres.exe"), "-D", str(DATA), "-C", "port"], text=True,
    ).strip())
    validate_endpoint(config, actual_port)
    process_status = subprocess.run([str(BIN / "pg_ctl.exe"), "-D", str(DATA), "status"], capture_output=True)
    if process_status.returncode == 3:
        run("pg_ctl", "-D", str(DATA), "-l", str(ROOT / ".local-data" / "postgres.log"), "-w", "start")
    elif process_status.returncode != 0:
        raise SystemExit("Cannot determine project PostgreSQL cluster status.")
    asyncio.run(provision(config))
    print(f"Project PostgreSQL ready on 127.0.0.1:{config['port']} (passwords are not printed).")


if __name__ == "__main__":
    main()
