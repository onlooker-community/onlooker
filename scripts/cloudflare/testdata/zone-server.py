"""A stand-in for the Cloudflare rulesets API, driven entirely by files.

Serves whatever rules a JSON file holds and records every PUT body it receives,
so a test can assert what the applier SENT rather than only what it printed.
That distinction is the reason this exists: "already matching, nothing to do"
and "applied the same thing again" produce identical output and differ only in
whether a request was made.

Usage: zone-server.py PORT RULES_JSON RECORD_PATH [--reject]

  RULES_JSON   a file holding a JSON array of rules to serve on GET. An empty
               array models a zone with no rate limiting at all.
  RECORD_PATH  every PUT body is appended here, one JSON object per line.
  --reject     answer PUT the way Cloudflare answers a bad payload: HTTP 200
               with success:false and an errors array. Not a 4xx, because
               that is genuinely how it reports a rejected rule, and a script
               reading curl's exit code instead of the flag would pass a test
               that used a 4xx and still break in production.

Used by apply.test.sh. Not shipped and not imported by anything else.
"""

import http.server
import json
import sys

PORT = int(sys.argv[1])
RULES = sys.argv[2]
RECORD = sys.argv[3]
REJECT = "--reject" in sys.argv[4:]


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        with open(RULES) as handle:
            rules = json.load(handle)
        self._json(
            200,
            {
                "success": True,
                "errors": [],
                "messages": [],
                "result": {
                    "id": "146be8e1fc824ed1907e49712474a6c6",
                    "phase": "http_ratelimit",
                    "kind": "zone",
                    "version": "1",
                    "rules": rules,
                },
            },
        )

    def do_PUT(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        with open(RECORD, "a") as handle:
            handle.write(raw.replace("\n", " ") + "\n")

        if REJECT:
            self._json(
                200,
                {
                    "success": False,
                    "errors": [
                        {"code": 20016, "message": "ratelimit.requests_per_period is invalid"}
                    ],
                    "messages": [],
                    "result": None,
                },
            )
            return

        sent = json.loads(raw) if raw else {"rules": []}
        self._json(
            200,
            {
                "success": True,
                "errors": [],
                "messages": [],
                "result": {
                    "id": "146be8e1fc824ed1907e49712474a6c6",
                    "phase": "http_ratelimit",
                    "kind": "zone",
                    "version": "2",
                    "rules": sent.get("rules", []),
                },
            },
        )

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
