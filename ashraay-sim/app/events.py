"""In-process event bus used to push live updates to browsers and the monitor (Server-Sent Events)."""
import json
import threading
import time


class EventBus:
    def __init__(self):
        self._cond = threading.Condition()
        self._version = 0
        self._last = []          # recent events (bounded)

    @property
    def version(self):
        return self._version

    def publish(self, kind, **data):
        with self._cond:
            self._version += 1
            evt = {"version": self._version, "kind": kind, "ts": time.time(), **data}
            self._last.append(evt)
            self._last = self._last[-200:]
            self._cond.notify_all()
            return evt

    def wait_after(self, version, timeout):
        """Block until an event newer than `version` exists (or timeout). Returns the new events."""
        with self._cond:
            if self._version <= version:
                self._cond.wait(timeout)
            return [e for e in self._last if e["version"] > version]

    @staticmethod
    def encode(evt):
        return f"id: {evt['version']}\nevent: update\ndata: {json.dumps(evt)}\n\n".encode()


bus = EventBus()
