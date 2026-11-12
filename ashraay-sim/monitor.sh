#!/usr/bin/env sh
cd "$(dirname "$0")"
exec python3 monitor.py --url "${1:-http://localhost:8080}"
