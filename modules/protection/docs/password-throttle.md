# Protection.PasswordThrottle

An `Auth.PasswordVerifier` that wraps `passwords` and bounds password guessing per identifier. It takes `passwords` (an `Auth.PasswordVerifier`) and `budget` (a `RateLimit.Budget`); the budget's `limit` and `window` say how many failures are allowed in how long.

## Per attempt

1. It reserves 1 on the budget under a key made from the SHA-256 of the identifier, so the identifier is not stored in the cache.
2. If the budget is spent, it answers `{ refused: true, reason: throttled }` and **does not call `passwords`**, so a throttled identifier costs no password hash and the right password gets no answer either.
3. Otherwise it calls `passwords`. On success it settles the reservation to 0, so successes spend nothing; a refusal leaves the 1 spent, so what the budget holds is the failed attempts of the window.

The answer of `passwords` is returned unchanged.

## Notes

- A throttled identifier is released when the window passes (`RateLimit.Budget` is a windowed budget); the retry time is not reported to the caller.
- Only failures are counted. A call in which `passwords` throws (an unreachable directory) leaves its reservation spent.
- Reservation and settlement are two calls on the budget, so simultaneous attempts on one identifier each hold a unit until they settle; the reservation is atomic, so no more than `limit` guesses are in flight or failed at once.
- Per-client-address throttling is a transport concern and stays there (the server's rate limit on the route); this kind bounds guessing of one account from many addresses. An attacker can still lock a known identifier out by failing on it on purpose: pair the throttle with transport limits and alerting.
- A budget in a store shared by replicas (`Cache.Store`) bounds failures across them; an in-memory store bounds them per replica.
