"""HTTP layer: routing, static files, JSON API and Server-Sent Events stream."""
import gzip
import json
import mimetypes
import re
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import config
from .events import bus
from .services import HazardService, ValidationError, NotFound

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")

# One single-page app; these paths all open it (the view is chosen from the path or #hash).
SPA = {"/", "/index.html", "/dashboard", "/weather", "/rivers", "/simulate", "/simulator", "/reservoir", "/monitor"}
service = None  # set in make_server


class Handler(BaseHTTPRequestHandler):
    server_version = "ASHRAAY-Sim/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "/api/stream" not in self.path and "/api/monitor/heartbeat" not in self.path:
            super().log_message(fmt, *args)

    # ---------- response helpers ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", **(extra or {})}
        if len(data) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "") and \
                (ctype.startswith("application/json") or ctype.startswith("text/") or "javascript" in ctype):
            data = gzip.compress(data, 5)
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _err(self, code, msg):
        self._send(code, {"error": msg})

    def _client(self):
        return self.client_address[0]

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > config.MAX_BODY_BYTES:
            raise ValidationError("request body too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ValidationError("body must be valid JSON")
        if not isinstance(data, dict):
            raise ValidationError("body must be a JSON object")
        return data

    # ---------- static ----------
    def _static(self, path):
        if path in SPA:
            f = config.WEB_DIR / "index.html"
        elif path == "/favicon.ico":
            f = config.WEB_DIR / "favicon.svg"
        else:
            f = (config.WEB_DIR / path.lstrip("/")).resolve()
            if config.WEB_DIR.resolve() not in f.parents:
                return self._err(404, "not found")
        if not f.is_file():
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, f.read_bytes(), ctype)

    # ---------- SSE ----------
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        last = bus.version
        try:
            hdr = self.headers.get("Last-Event-ID")
            if hdr and hdr.isdigit():
                last = min(int(hdr), bus.version)
            self.wfile.write(f"retry: 3000\nevent: hello\ndata: {json.dumps({'version': bus.version})}\n\n".encode())
            self.wfile.flush()
            while True:
                events = bus.wait_after(last, config.SSE_KEEPALIVE_SEC)
                if events:
                    for e in events:
                        self.wfile.write(bus.encode(e))
                    last = events[-1]["version"]
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            return

    # ---------- routing ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        p, qs = u.path.rstrip("/") or "/", parse_qs(u.query)
        try:
            if not p.startswith("/api/"):
                return self._static(p)
            if p == "/api/stream":
                return self._stream()
            if p == "/api/health":
                return self._send(200, {"ok": True, "version": bus.version, "token_required": bool(config.SIM_TOKEN)})
            if p == "/api/version":
                return self._send(200, {"version": bus.version})
            if p == "/api/snapshot":
                return self._send(200, service.snapshot())
            if p == "/api/meta":
                return self._send(200, service.meta())
            if p == "/api/stations":
                return self._send(200, service.snapshot()["stations"])
            if p == "/api/reservoirs":
                return self._send(200, service.snapshot()["reservoirs"])
            if p == "/api/weather":
                areas, dates = service.weather()
                return self._send(200, {"dates": dates, "areas": areas})
            if p == "/api/warnings":
                return self._send(200, service.repo.warnings(active_only="all" not in qs))
            if p == "/api/audit":
                return self._send(200, service.repo.audit())
            if p == "/api/monitor":
                return self._send(200, service.monitor_log())
            m = re.fullmatch(r"/api/stations/([\w\-]+)", p)
            if m:
                return self._send(200, service.station(m.group(1)))
            m = re.fullmatch(r"/api/reservoirs/([\w\-]+)", p)
            if m:
                return self._send(200, service.reservoir(m.group(1)))
            m = re.fullmatch(r"/api/weather/([\w\-]+)", p)
            if m:
                return self._send(200, service.area(m.group(1)))
            return self._err(404, "unknown endpoint")
        except NotFound as e:
            return self._err(404, str(e))
        except Exception as e:  # pragma: no cover
            return self._err(500, f"server error: {e}")

    def do_POST(self):
        p = urlparse(self.path).path.rstrip("/")
        try:
            if not (p.startswith("/api/sim/") or p.startswith("/api/monitor/")):
                return self._err(404, "unknown endpoint")
            if config.SIM_TOKEN and self.headers.get("X-Sim-Token") != config.SIM_TOKEN:
                return self._err(401, "simulation token required")
            body, c = self._body(), self._client()
            if p == "/api/sim/rain":
                return self._send(200, service.simulate_rain(body, c))
            m = re.fullmatch(r"/api/sim/station/([\w\-]+)", p)
            if m:
                return self._send(200, service.simulate_station(m.group(1), body, c))
            m = re.fullmatch(r"/api/sim/reservoir/([\w\-]+)", p)
            if m:
                return self._send(200, service.simulate_reservoir(m.group(1), body, c))
            if p == "/api/sim/scenario":
                return self._send(200, service.scenario(body, c))
            if p == "/api/sim/warnings":
                return self._send(200, service.create_warning(body, c))
            m = re.fullmatch(r"/api/sim/warnings/(\d+)/clear", p)
            if m:
                return self._send(200, service.clear_warning(int(m.group(1)), c))
            if p == "/api/sim/reset":
                return self._send(200, service.reset(c))
            if p == "/api/monitor/heartbeat":
                return self._send(200, service.monitor_heartbeat(body))
            if p == "/api/monitor/report":
                return self._send(200, service.monitor_report(body, c))
            if p == "/api/monitor/clear":
                return self._send(200, service.clear_monitor_log(c))
            return self._err(404, "unknown endpoint")
        except ValidationError as e:
            return self._err(400, str(e))
        except NotFound as e:
            return self._err(404, str(e))
        except Exception as e:  # pragma: no cover
            return self._err(500, f"server error: {e}")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(host=None, port=None, svc=None):
    global service
    service = svc or HazardService()
    return Server((host or config.HOST, config.PORT if port is None else port), Handler)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("127."))
