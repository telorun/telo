---
"@telorun/debug-ui": patch
---

Fix the debug watcher rendering blank once a structured log record reaches the stream. The event views narrowed frames as "anything that is not a log", so a `record` frame was read as an event and `eventSuffix(undefined)` threw during render, unmounting the whole tree. They now narrow with `isEventFrame`, which excludes both `log` and `record`.
