"""Create or update a Command Center staff account (incident commander + verifier + platform admin).

Usage: python database\\create-staff.py --phone 9876543210 --email admin@example.com
The password is prompted for and never echoed or passed on the command line.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / ".local-data" / "postgres.json"


async def upsert(phone: str, email: str, password: str, name: str | None) -> str:
    from sqlalchemy import or_, select

    from app.accounts import UserAccount, _clean_phone, _hash_secret
    from app.database import Base, engine, sessions

    phone = _clean_phone(phone)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        user = await session.scalar(
            select(UserAccount).where(or_(UserAccount.phone == phone, UserAccount.email == email))
        )
        if user is None:
            session.add(UserAccount(
                id=str(uuid4()), phone=phone, email=email, role="staff", name=name,
                password_hash=_hash_secret(password), mpin_hash=None,
                created_at=datetime.now(timezone.utc).isoformat(),
            ))
            result = "created"
        else:
            user.role = "staff"
            if name:
                user.name = name
            user.password_hash = _hash_secret(password)
            user.failed_attempts = 0
            user.locked_until_ms = 0
            result = "updated (now staff)"
        await session.commit()
    await engine.dispose()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--phone", required=True, help="10-digit mobile number used to sign in")
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", help="display name shown in the Command Center")
    args = parser.parse_args()

    if not os.getenv("DATABASE_URL"):
        if not CONFIG.exists():
            sys.exit("Run start-server.bat once first so .local-data\\postgres.json exists.")
        os.environ["DATABASE_URL"] = json.loads(CONFIG.read_text(encoding="utf-8"))["databaseUrl"]
    sys.path.insert(0, str(ROOT / "command-center" / "web-app"))

    password = getpass.getpass("Staff password (min 8 chars): ")
    if len(password) < 8:
        sys.exit("Password must be at least 8 characters.")
    if getpass.getpass("Confirm password: ") != password:
        sys.exit("Passwords do not match.")

    result = asyncio.run(upsert(args.phone, args.email.strip().lower(), password, (args.name or "").strip()[:80] or None))
    print(f"Staff account {args.phone} {result}. Sign in on the Command Center with the Staff tab.")


if __name__ == "__main__":
    main()
