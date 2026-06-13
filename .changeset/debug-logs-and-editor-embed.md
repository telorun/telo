---
"@telorun/debug-wire": minor
"@telorun/debug-ui": minor
"@telorun/cli": minor
---

Debug stream now carries **logs as well as events**, and the editor embeds the
debug UI.

- New `@telorun/debug-wire` package: the language-neutral frame contract shared
  by the producer, the runner, the editor, and the debug UI. A stream now carries
  two discriminated frame kinds on one channel — `kind: "event"` (kernel events)
  and `kind: "log"` (one stdout/stderr line). Browser-safe; `wire-schema.json` is
  the source of truth a non-TypeScript producer conforms to. `@telorun/debug-ui`
  re-exports its types.
- `@telorun/cli`: `--inspect` / `--debug` now tee the run's stdout/stderr into the
  stream as `log` frames (the terminal is untouched; the tee is restored on stop).
  The inspect server adds permissive CORS so an embedding webview can read it.
- `@telorun/debug-ui`: the watcher is now a **Logs / Events** tab split over one
  frame stream (`DebugPanel` + `LogView`); `DebugWatcher` wraps it for the
  standalone app. `connectDebugStream` delivers `DebugFrame`s routed by `kind`.
  Components take a `theme` prop (`"light" | "dark" | "system"`, default
  `"system"` — follows `prefers-color-scheme` live); `DebugPanel` also takes a
  `logsSlot` (an embedding host can render its own interactive terminal in the
  Logs tab) and a `defaultTab`. When **no** `theme` is supplied the panel owns
  its mode and shows a system/light/dark toggle in its header; when a host
  passes `theme`, the host owns it and the toggle is hidden.

The editor (private) embeds `DebugPanel` in the run view's Debug tab: remote
HTTP/k8s runners relay frames over the existing `/v1/sessions/:id/events`
transport (the security/ingress boundary), while the local runner reads the
workload's loopback `--inspect` port directly — both surface identical `debug`
run events. Blob payloads aren't resolvable in the editor embed yet (the
workload's blob endpoint isn't reachable from the editor); events and logs work.
