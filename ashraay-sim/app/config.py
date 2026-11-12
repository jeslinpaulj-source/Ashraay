"""Runtime configuration (env vars or CLI flags in server.py)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("FFS_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "ashraay_sim.db"

HOST = os.environ.get("FFS_HOST", "0.0.0.0")       # 0.0.0.0 => reachable via localhost AND your LAN IP
PORT = int(os.environ.get("FFS_PORT", "8080"))

# Optional shared secret for simulation + monitor endpoints. Empty = no check.
SIM_TOKEN = os.environ.get("FFS_SIM_TOKEN", "")

MAX_BODY_BYTES = 64 * 1024
SSE_KEEPALIVE_SEC = 15
HISTORY_HOURS = 48
FORECAST_DAYS = 5
MONITOR_ONLINE_SEC = 30          # monitor counts as "online" if it sent a heartbeat this recently
