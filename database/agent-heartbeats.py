"""Print the number of live agent heartbeats from project PostgreSQL."""
import asyncio
import json
from pathlib import Path
import sys
import time

import asyncpg


async def main():
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    connection = await asyncpg.connect(config["agentUrl"], timeout=3)
    try:
        count = await connection.fetchval(
            "SELECT count(*) FROM agent_heartbeat WHERE status='running' AND last_seen_ms > $1",
            int(time.time() * 1000) - 30000,
        )
        print(count)
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(main())
