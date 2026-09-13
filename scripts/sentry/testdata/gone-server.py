"""A stand-in for a Sentry endpoint inside a deprecation brownout.

Answers 410 to everything, with the same two headers Sentry sends:
x-sentry-deprecation-date and x-sentry-replacement-endpoint.

This exists because "unreachable" and "reachable but refusing" are different
code paths, and only the second one produced the bug it guards. Against an
unreachable host the applier crashed under `set -e`; against a host that
answered 410 to every request it printed "no drift: every rule in these
projects is defined here" - a clean bill of health from a check that had read
nothing. A connection-failure test would never have caught it.

Used by apply.test.sh. Not shipped and not imported by anything else.
"""

import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def _gone(self):
        self.send_response(410)
        self.send_header("Content-Type", "application/json")
        self.send_header("x-sentry-deprecation-date", "2026-05-14T00:00:00+00:00")
        self.send_header("x-sentry-replacement-endpoint", "/api/0/organizations/onlooker-vw/workflows/")
        self.end_headers()
        self.wfile.write(b'{"message":"This API no longer exists."}')
    do_GET = do_POST = do_PUT = _gone
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
