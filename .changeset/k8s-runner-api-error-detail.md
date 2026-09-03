---
"@telorun/k8s-runner": minor
---

A Kubernetes API rejection no longer reaches the session's client verbatim. The
client-node `ApiException`'s message is a full HTTP dump — the raw `Status` body,
the response headers — and a start failure's message travels unchanged to the
client as the session's terminal `failed` status, so a missing RBAC grant put the
runner's ServiceAccount name, the request's audit id and its flowschema UIDs on
an end user's screen in telo studio.

The client is now told the operation, the HTTP status and the API's own one-word
`reason` (`Forbidden`, `NotFound`), plus the one remediation a 401/403 implies —
enough for an operator to know which permission is at fault. The raw exception
rides along as the error's `cause`, which the runner's log serializer records, so
the detail moves to the log rather than disappearing. Same treatment for the pod
watch, the PTY attach and a watch session's endpoint publish, each of which wrote
the same dump into a status message or the user's terminal.
