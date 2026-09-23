"""A stand-in for a Sentry org that holds two detectors of the same type.

Project 4512075995283456 really does carry two `monitor_check_in_failure`
detectors - one per cron monitor - and that is the case apply.sh could not tell
apart. `detector_for` selected on (projectId, type) and took `first`, so a rule
naming only those two fields bound to whichever the API happened to list first.
One of the two sits in front of a DISABLED monitor that receives nothing, so the
wrong pick produces a workflow that cannot fire: the exact fault onlooker-txcu.9
exists to remove.

The ids and names here are the live ones, so a failure reads the same as the
thing it is standing in for.

Serves the three calls a run makes: list detectors, list workflows, create one.
POST echoes the detectorIds it was handed, and apply.sh prints the id it bound -
which is what lets a test tell "refused because ambiguous" apart from "bound to
the right one", two outcomes that otherwise share an exit code.

The workflow list carries one of each kind on purpose. `API fault (production)`
is defined in rules/api-faults.json and must never be called drift; the
hand-made one is in no file and always must be. A fix that silenced drift
altogether would satisfy the first on its own, so the second is what stops that
from passing.

Used by apply.test.sh. Not shipped and not imported by anything else.
"""

import http.server, json, sys

DETECTORS = [
    {
        "id": "10315978",
        "name": "Heartbeat workflow",
        "projectId": 4512075995283456,
        "type": "monitor_check_in_failure",
    },
    {
        "id": "10315979",
        "name": "Client error monitor workflow",
        "projectId": 4512075995283456,
        "type": "monitor_check_in_failure",
    },
    {
        "id": "10314452",
        "name": "Error Detector",
        "projectId": 4512075995283456,
        "type": "issue_stream",
    },
]

WORKFLOWS = [
    {
        "id": "3984740",
        "name": "API fault (production)",
        "detectorIds": ["10314452"],
    },
    {
        "id": "7777777",
        "name": "Hand-made during an incident",
        "detectorIds": ["10314452"],
    },
]


class H(http.server.BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/detectors/"):
            return self._json(200, DETECTORS)
        if self.path.endswith("/workflows/"):
            return self._json(200, WORKFLOWS)
        self._json(404, {"detail": "no such endpoint"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        sent = json.loads(self.rfile.read(length) or b"{}")
        self._json(201, {"id": "99999", **sent})

    do_PUT = do_POST

    def log_message(self, *a):
        pass


http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
