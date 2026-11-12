#!/usr/bin/env python3
"""Start the ASHRAAY Hazard Simulator (weather + rivers + dams).

    python server.py                 # http://localhost:8080  and  http://<your-ip>:8080
    python server.py --port 9000
    python server.py --reset         # re-seed all data before starting
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import config, __version__          # noqa: E402
from app.http import make_server, lan_ips     # noqa: E402


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="ASHRAAY Hazard Simulator (local)")
    ap.add_argument("--host", default=config.HOST)
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--reset", action="store_true", help="re-seed data before starting")
    ap.add_argument("--open", action="store_true", help="open the dashboard in the browser once started")
    a = ap.parse_args()

    try:
        srv = make_server(a.host, a.port)
    except OSError as e:
        print(f"\n  Could not start on port {a.port}: {e}\n  Is it already running? Try: python server.py --port 9000\n")
        sys.exit(1)
    from app import http as h
    if a.reset:
        h.service.reset("cli")

    print(f"\n  ASHRAAY Hazard Simulator v{__version__}  (SIMULATION - not official data)\n")
    print(f"  Dashboard         http://localhost:{a.port}/")
    print(f"  Weather forecast  http://localhost:{a.port}/#/weather")
    print(f"  Rivers & dams     http://localhost:{a.port}/#/rivers")
    print(f"  Simulator         http://localhost:{a.port}/#/simulator")
    print(f"  Monitor log       http://localhost:{a.port}/#/monitor")
    for ip in lan_ips():
        print(f"  On your network   http://{ip}:{a.port}/")
    if config.SIM_TOKEN:
        print("  Simulation token  required (FFS_SIM_TOKEN is set)")
    print(f"  Data file         {config.DB_PATH}")
    print(f"\n  Next: double-click monitor.bat (Windows) to start the watch agent.\n  Press Ctrl+C to stop.\n")
    if a.open:
        import threading, webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{a.port}/")).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        srv.server_close()


if __name__ == "__main__":
    main()
