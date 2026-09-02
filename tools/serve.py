#!/usr/bin/env python3
"""Static server for local development.

    python3 tools/serve.py [port]

Identical to `python3 -m http.server` except that it sends `Cache-Control:
no-store`. The stdlib server sends only `Last-Modified`, and with no
`Cache-Control` browsers apply heuristic freshness — so an edited app.js can
keep serving from cache without ever revalidating, and you debug a stale file.
"""
import functools
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The envelopes are published from a sibling repo as their own Pages site, so
# mirror that layout here: requests for /mashMusic-eq/* are served from it.
EQ_PREFIX = "/mashMusic-eq/"
EQ_DIR = os.path.join(os.path.dirname(ROOT), "mashMusic-eq")


class NoCacheHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith(EQ_PREFIX):
            rel = clean[len(EQ_PREFIX):]
            # keep the request inside EQ_DIR whatever it asks for
            safe = [p for p in rel.split("/") if p not in ("", ".", "..")]
            return os.path.join(EQ_DIR, *safe)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not args or not str(args[0]).startswith(("GET /mashMusic-eq/", "GET /data/tracks")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8412
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    print("serving %s at http://localhost:%d (no-store)" % (ROOT, port))
    print("  %s -> %s" % (EQ_PREFIX, EQ_DIR))
    HTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
