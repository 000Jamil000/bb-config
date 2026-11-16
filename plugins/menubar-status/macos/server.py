#!/usr/bin/env python3
"""Local helper for the bb menu bar panel.

Serves the panel page and the status file to the SwiftBar web popover, and
opens bb (or a thread's web page) when a row is clicked. Listens on loopback
only; every request must carry the token created at install time.
"""
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
STATUS_FILE = os.environ.get("BB_MENUBAR_STATUS", os.path.join(HERE, "status.json"))
PORT = int(os.environ.get("BB_MENUBAR_PORT", "47615"))
with open(os.path.join(HERE, "token"), encoding="utf-8") as handle:
    TOKEN = handle.read().strip()


def read_feed():
    try:
        with open(STATUS_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if query.get("t", [""])[0] != TOKEN:
            self.reply(403, "{}")
            return
        if url.path == "/":
            with open(os.path.join(HERE, "panel.html"), "rb") as handle:
                self.reply(200, handle.read(), "text/html")
        elif url.path == "/status":
            self.reply(200, json.dumps(read_feed()))
        elif url.path == "/open":
            # Only bb itself, or a thread address that is in the feed.
            thread = query.get("thread", [""])[0]
            feed = read_feed() or {}
            link = next(
                (item.get("url") for item in feed.get("items", []) if item.get("id") == thread),
                None,
            )
            if query.get("web", [""])[0] == "1" and link and link.startswith("https://"):
                subprocess.Popen(["/usr/bin/open", link])
            else:
                subprocess.Popen(["/usr/bin/open", "-a", "bb"])
            self.reply(200, "{}")
        else:
            self.reply(404, "{}")


if __name__ == "__main__":
    host = "127.0.0.1"
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    ThreadingHTTPServer((host, PORT), Handler).serve_forever()
