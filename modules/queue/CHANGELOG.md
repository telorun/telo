# Changelog

## 0.3.0 - 2026-11-06
### Added
* `Queue.Worker`'s `inputs` and `onDead.inputs` declare `default: {}`, so `telo check` judges a handler or dead-letter hook wired without `inputs:` as receiving `{}`, and refuses one whose contract requires an argument.

## 0.2.0 - 2026-11-04
### Added
* New module: durable typed work queues for background jobs, named Queues and imported as Queue. Queue.Queue (messageType, maxMessageBytes) and Queue.AddressableQueue (retention, ids deduplicate) are abstracts a storage module implements through the store contract in @telorun/queue. Enqueue and EnqueueMany add messages with an optional id and a delay or instant; Worker claims under a renewed lease and cancels its handler itself when renewals cannot be confirmed with a third of the lease left, runs a handler with a per-attempt timeout, re-attempts under the shared retry policy with the backoff stored as a visibility time, honours nonRetryable and retryAfter, dead-letters after an optional onDead handler, hands unfinished work back on shutdown after shutdownGrace, and continues the enqueuing trace; Stats, Status, List, Cancel and Requeue inspect and manage messages. A storage failure is the retryable ERR_QUEUE_UNAVAILABLE; ERR_QUEUE_STORE_INCONSISTENT and ERR_QUEUE_GROUP_INVALID are terminal. Delivery is at-least-once. Requires telo 0.122.0.
