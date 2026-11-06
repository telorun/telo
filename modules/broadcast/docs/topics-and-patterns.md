# Topics and patterns

A message may carry a `topic`: dot-separated segments of lower-case letters,
digits, `_` and `-`, at most 128 bytes (`rooms.42`, `tasks.7.comments`). A topic
is a string given at publish time, so one channel carries any number of them — a
room, a record, one user's notifications — without a resource each. A topic
outside the grammar is refused before the app runs when written as a literal and
with `ERR_INPUT_INVALID` when computed.

A subscription's `topics` is a list of patterns over the same grammar:

- `*` matches exactly one segment: `rooms.*` matches `rooms.42` and not
  `rooms.42.typing` or `rooms`.
- `>`, last only, matches one or more segments: `rooms.>` matches `rooms.42` and
  `rooms.42.typing`, not `rooms`; `>` alone matches every topic.
- A literal segment matches itself.

A pattern breaking the grammar (`rooms.**`, `>.a`) is a `SCHEMA_VIOLATION`.
Omitting `topics` receives every message on the channel, a topic-less one
included; giving it receives only messages that have a matching topic. A topic
is a filter applied by each subscriber, never a security boundary.
