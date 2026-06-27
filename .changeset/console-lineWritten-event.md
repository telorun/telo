---
"@telorun/console": minor
---

Rename the event emitted by `Console.WriteLine` from `StdOut.LineWritten` to
`LineWritten`. The kind already namespaces its events, so the `StdOut.` prefix
was redundant. Subscribers must listen for `LineWritten` instead.
