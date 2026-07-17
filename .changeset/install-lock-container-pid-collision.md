---
"@telorun/kernel": patch
---

Make the controller-install lock (`.telo/npm/.lock`) robust in containers.

The staleness check probed the recorded holder PID for liveness, but PID
identity is unreliable across container restarts and PID namespaces —
deterministic PID reuse made an unrelated process (often the very process
trying to acquire the lock) look like the dead holder on the same hostname, so
a stale lock either deadlocked the boot or burned the full 5-minute wait before
failing, all silently.

The lock is now heartbeat-based: the holder refreshes the lock file's mtime
every 5s while it works, and a waiter reclaims any lock whose mtime is older
than 30s (holder crashed/killed/vanished). mtime age is the only reclaim
signal — the `{pid, host}` in the lock body is diagnostics, never probed.
Reclaim is an atomic `rename` to a unique tombstone, so two waiters that both
observe a stale lock can't both reclaim it. A wait longer than 2s now prints a
stderr notice instead of looking like a hang.
