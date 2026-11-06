# The subscription

`Broadcast.Subscription` is a `Telo.Service`: live, and holding nothing once it
stops. Like every service it starts only when `targets:` (or a scope's `targets:`)
names it, and it holds a kernel hold while subscribed.

```yaml
kind: Broadcast.Subscription
metadata: { name: dropOnChange }
channel: !ref cacheEvents
topics: [tenants.*.cache]
invoke: !ref dropCacheEntry
inputs: { key: !cel "message.key" }
concurrency: 1
buffer: 256
onGap:
  invoke: !ref reloadAll
onError:
  invoke: !ref noteFailure
  inputs: { code: !cel "error.code" }
```

## The handler

`invoke` is any invocable, run for each message whose topic matches, with its
`inputs:` evaluated over `topic` (null when none was sent) and `message` (the
channel's `messageType`). Without `inputs:` the handler is invoked with `{}`. The
map is held to the handler's `inputType` by `telo check`, so a handler requiring
`key` with no `inputs:`, or `inputs: { key: !cel "message.kye" }`, is refused
before the app runs; a handler receives exactly the mapped object. At most `concurrency` messages are
handled at once (default 1, so in order); up to `buffer` more wait (default 256).
A message finding the buffer full drops the whole backlog and itself, and raises
a gap; messages after it are handled normally.

## Failures

Nothing stops a subscription:

- A handler that fails, or a received message that is not of the channel's
  `messageType` (`ERR_BROADCAST_MESSAGE_INVALID`, from a publisher on another
  version), is logged at error level with its code and recorded as an error on
  the dispatch span.
- `onError`, when written, then runs with `inputs` evaluated over `error`
  (`{ code, message, data? }`), `topic` (null when none or unreadable) and
  `message` (null when it could not be read as one of the channel). A failure of
  the hook is only logged. A failed message is not retried: there is nothing to
  retry for an at-most-once hint.
- A gap — the buffer overflowed, or the backend's connection dropped — runs
  `onGap` when written, with `inputs` evaluated over `reason`; without it the gap
  is logged at warning level. A consumer that must stay correct re-reads its
  source of truth there.

When the subscription stops, the channel stops delivering, queued messages are
dropped and handlers still running are cancelled.
