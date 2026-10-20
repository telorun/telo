---
description: "The guarantees, checks and defaults a Telo application gets without writing them — each one something a typed framework leaves to hand-written code or team discipline."
---

# What you get for free

Telo checks what a typed framework leaves to discipline: that a write meant for
a transaction is inside one on every path, that every error a handler can throw
is rendered somewhere, that a retry would not silently resend a stream already consumed,
that shutdown undoes exactly what startup did. Your compiler checks your types;
these are the bugs that pass it.

This page lists each one against what you would otherwise write in TypeScript,
Go or Java with their usual libraries. It grows with every release.

## Highlights

- **Crashes resume where they stopped.** Durable runs record every step and decision, so a restart continues from the record, and the ways durability silently breaks — a non-deterministic call, a swallowed suspension — are refused. No checkpointing code, no workflow engine to deploy. [Reliability](#reliability)
- **Every error has a handler.** Each error code a handler declares is checked against the `catches:` entries of its route, router and server; one nothing renders is an error before the app runs. [Errors](#errors)
- **Transactions are ambient, and checked.** Every statement reached through a `Sql.Transaction` joins it at any depth, and a statement that requires one is checked on every path the analyzer can see, the runtime refusing the rest (`ERR_ZONE_REQUIRED`). [Coordination & data integrity](#coordination--data-integrity)
- **Retries that can't do harm.** Cancellations and contract violations are never retried, a retry that would resend a consumed stream is refused, and a timeout cancels the call instead of abandoning it. [Reliability](#reliability)
- **Cleanup writes itself.** Every resource returns its own undo, run in dependency order on failure and on shutdown — no try/finally, no teardown mirroring startup. [Lifecycle](#lifecycle)
- **Schema changes keep the running version working.** Declared tables reconcile at boot under a lock; removals wait for `reclaim:`, renames go expand-contract, and changes it detects as unsafe are refused before any DDL. [Lifecycle](#lifecycle)
- **Credentials stay out of telemetry.** Secrets, URL passwords and fields marked sensitive are redacted in logs, errors and traces, and spans carry no payloads unless a contract opts a field in. [Security](#security)
- **Wiring mistakes are caught before anything runs.** `telo check` and the editor resolve every reference, schema and expression — the configuration, wiring and query typos a compiler cannot see — and the runtime refuses the same things at load with the same message. [Static analysis & editing](#static-analysis--editing)

Within each section below, rows are ordered by weight: the ones replacing the
most come first.

Every diagnostic code below without an `ERR_` prefix is reported by
`telo check` and in the editor, before anything runs.

## Static analysis & editing

| With Telo | Without it |
| --- | --- |
| `telo check` resolves every import, reference, schema and expression with no database, network or process; exits non-zero on errors only; `-o json` gives `file` / `line` / `column` / `code` / `fix` | Configuration, wiring and query typos found at runtime even when the code compiles |
| `telo run` runs the same analysis and refuses to start; runtime refusals mirror static ones as `ERR_<code>` with the same wording | A half-started process; a linter and a runtime that disagree |
| The editor runs the exact engine of the telo version the module's `requires: telo:` selects, and the local runner runs that same release | An editor plugin drifting from CI; works in the editor, fails in staging |
| Studio: Topology, Inventory, Source and Deployment views over the YAML on disk, edits round-tripping | A diagram nobody keeps in sync with the code |
| A security setting that would protect nothing is refused: a sensitive mark no contract reaches (`SENSITIVE_ANNOTATION_MISPLACED`), a redaction path that does not parse (`INVALID_REDACTION_PATH`), a version requirement nothing compares (`NEED_CONSTRAINT_UNVERIFIED`) | A redaction rule or version pin that silently does nothing |

## Authoring & composition

| With Telo | Without it |
| --- | --- |
| When the standard library lacks something, a controller in TypeScript or Rust becomes a new kind: its schema, references and contract are checked like a built-in's, its code is ordinary TypeScript or Rust | Custom components outside the framework's checks |
| References must resolve to a resource of the kind the slot accepts (`UNRESOLVED_REFERENCE`, `REFERENCE_KIND_MISMATCH`) | Dependency-injection wiring errors found at startup |
| A library imported by relative `source:`; publishing it changes only that `source:` | A private package, its build and its registry |
| The hub's MCP server gives coding agents `search_resources`, `get_kinds` with exact pins and schemas, and authoring guides | Agents guessing package names and option shapes |

## Data shape

| With Telo | Without it |
| --- | --- |
| `Crud.Model`'s four shapes (read, list, create, update), checked for consistency | DTOs and mappers per endpoint |
| A declared SQL table projects its row, so seed rows, filters and keys are checked against its columns (`SQL_SEED_KEY_UNKNOWN_COLUMN`) | ORM models kept in sync with migrations |
| Malformed URLs (`URL_INVALID`), regexes (`CEL_INVALID_ARGUMENT`), Telo formats, durations and cron expressions in configuration refused before start | A malformed value found at startup or on the request that uses it |
| One enum declaration: a native type on PostgreSQL, a `CHECK` on SQLite | An enum emulation per database engine |

## Inputs & boundaries

| With Telo | Without it |
| --- | --- |
| `inputType` / `outputType` validated at runtime on every call between resources, not only at the HTTP edge (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`); defaults filled into a copy | Validation at the edge only, internal callers trusted; mutated input |
| Duplicate routes and MCP tool names refused | A later route silently shadowing an earlier one |
| CRUD lists accept only declared filters and sorts, validating `limit` / `sort` / `cursor` | Hand-validated query strings and queries on unindexed columns |
| Every input bounded by default: `maxBodyBytes` (1 MiB, always on), multipart limits, `maxBytes` on reads, agent `maxSteps` / `maxToolResultBytes`, bounded channel reads | Unbounded reads; runaway agent loops |
| HTTP inputs validated and typed before the handler, with a standard 400 envelope; OpenAPI built from the routes and served offline; `Accept` negotiated | Validator, error formatter and spec configured per framework |
| Vector `dimensions` enforced at insert and query | Corrupted similarity results |

## Configuration

| With Telo | Without it |
| --- | --- |
| Dependency configuration read from derived names (`TELO_NEED_ORDERS__DATABASE_ACCESS__URL`); `telo needs report` and `telo module manifest --json` list every input without booting | A name invented and documented for each dependency's setting |
| A missing or partly supplied dependency setting names every variable to set before boot (`ERR_NEED_UNMET`, `ERR_NEED_PARTIALLY_SUPPLIED`); two settings reading one variable are refused (`NEED_ENV_NAME_COLLISION`) | Cryptic connection failures; two settings sharing one variable |
| A dependency's `version:` / `features:` checked against what the resource finds at start | A missing database extension found at the first query |
| Only the root application reads environment variables and arguments (`LIBRARY_ENV_KEY_REJECTED`) | Dependencies reading arbitrary environment variables |
| Inputs declared once with `env:` and `type:`, every failure reported together before start; a declared variable reads as unset through the process environment, so code reading it directly gets nothing | Configuration read in many places, some bypassing validation |
| `telo run` at a terminal asks for each input nothing supplies — a secret without echo, each answer checked as the environment variable would be and asked again with the reason when refused — then offers to save the answers to `.env` / `.env.local`; a watch session asks once; nothing is asked under `--no-input`, in a runner or without a terminal | A startup crash per missing variable; a hand-written setup prompt |
| `arg:` bindings and `--help` generated from the same declarations: every argument, every environment-only input with its type and default, the needs; a secret can never be an argument | A CLI parser and a help text kept in sync by hand |
| `Telo.PublicUrl` derived from host templates; two addresses no host could route apart refused (`ERR_NEED_PUBLIC_URL_COLLISION`) | A hard-coded base URL per environment |
| Paths in configuration always absolute (`HOST_PATH_RELATIVE`); files a module ships found wherever it is unpacked, and checked to exist | Paths resolved against wherever the process started; assets missing from the image |
| `ports:` typed, TCP or UDP, known to a runner before boot | A port number repeated in code, Dockerfile and deploy config |
| `telo env template` writes `.env` and `.env.local` from the manifest — every variable with its default and whether it is required, secrets and sensitive need fields kept to the file `env.files` marks sensitive (`.env.local` by default), re-runs adding only what is new | A hand-kept `.env.example` drifting from the code |
| `.env` / `.env.local` collected up to the workspace marker, by `telo run` and Studio runs alike | Per-package copies of env files; an editor's own copy of the values |

## Errors

| With Telo | Without it |
| --- | --- |
| Error coverage checked: a declared error code no `catches:` entry renders (`UNCOVERED_THROW_CODE`), a catch for a code nothing throws (`UNDECLARED_THROW_CODE`), a missing or misplaced catch-all (`UNBOUNDED_UNION_NEEDS_CATCHALL`, `CATCHALL_NOT_LAST`) | Unmapped errors reaching clients as 500s; dead or order-dependent handlers |
| The `catches:` ladder: route → `Http.Api` → `Http.Server` → built-in 500 | A global handler with a chain of type checks |
| `throws: { inherit: true }` carries a body's error codes through wrappers, so a route can catch a code thrown inside a transaction | Error types lost at every layer |
| Coded errors (`code`, `message`, `data`, `step`), typed in `catch:` and `catches:` | Matching on error message strings |
| Failures point at the cause in your manifest: root cause first, resources blocked by it collapsed under it, location named | The real error buried in a cascade of follow-on failures |
| One closed error set per client family (AI providers, graph, search, OCR, MCP), with `retryAfterSeconds` | Per-vendor error parsing |

## Lifecycle

| With Telo | Without it |
| --- | --- |
| Resources return their own undo, run newest-first on failure; a failed init is discarded | try/finally; a teardown mirroring startup; half-built objects |
| Startup order derived from references, loops traced (`DEPENDENCY_CYCLE`) | A hand-ordered boot sequence; startup deadlocks |
| `Postgres.Schema` / `SQLite.Schema` reconcile at boot under an advisory lock, one transaction per batch, touching only objects they declare | Migration files; replicas racing each other; dropping a table you don't own |
| Schema changes stay compatible with the running version: removals tombstoned until `reclaim:`, renames expand-contract (`renamedFrom:`), and changes it detects as unsafe — narrowing a type, `NOT NULL` over existing NULLs — refused before any DDL | Down-migrations; migrations that half-apply |
| Shutdown in dependency order, log sinks last, every undo attempted even when one fails (`ERR_EFFECT_RECOVERY_FAILED`) | Hand-ordered shutdown hooks; one exception stranding the rest of cleanup |
| Background work tracked: its failures logged, waited for at shutdown, and work against a torn-down resource refused (`ERR_EFFECT_SCOPE_CLOSED`) | Unhandled failures; work outliving what it uses |
| The process stays up while something serves or schedules, and exits when the work is done; waiting on something that can never happen exits 1 with a reason | Keep-alive hacks; a process that exits too early, or reports success when it was stuck |
| `SIGINT` / `SIGTERM` cancel in-flight work and tear down, with defined exit codes, identically in packaged binaries | Signal handling and exit codes written per service |

## Reliability

| With Telo | Without it |
| --- | --- |
| Durable runs record steps and decisions; a crash resumes where it stopped | Checkpointing by hand, or a workflow engine and its determinism rules |
| Durability can't break silently: swallowed suspensions detected, catches rethrow them, a replay reaching a different step refused (`ERR_JOURNAL_ENTRY_MISMATCH`), `now()` / `uuidv4()` inside a replayed region refused (`DURABLE_NONDETERMINISM`) | Corrupt resumes; replays that diverge |
| Durable timing survives restarts: long backoffs park with their attempt count, deadlines fixed on the first pass, missed schedules found due | Timers and retry budgets reset on every redeploy; dropped cron runs |
| Retries that can't do harm: cancellations and contract violations never retried, `nonRetryable:` codes, a retry that would resend a consumed stream refused (`LIVE_VALUE_RETRIED`, `ERR_HTTP_BODY_NOT_REPLAYABLE`), backoff cancellable with the original failure kept | Retrying a typo; resending an empty body; losing the real error |
| A per-attempt `timeout:` cancels the call rather than abandoning it (`ERR_STEP_TIMEOUT`) | A timeout that leaves the side effect running |
| Cancellation flows down the call tree to every call that honours it; shutdown cancels calls rather than failing them | A cancellation token threaded through every call; Ctrl-C making work terminal |
| `retry:` declared on any call, exponential backoff with full jitter | Retry loops written per call site |
| Outbound HTTP resilient by default: retries, `Retry-After`, a 10 s timeout, normalized network errors, credential refresh on 401 | A retry library, a forgotten timeout, token-refresh interceptors |
| Postgres pools probe and replace dead connections; `LISTEN` re-subscribes after reconnecting | Connection errors after a failover; listeners that hear nothing |
| `Cache.View`: stale-while-revalidate, single-flight, stale-if-error | Caching decorators written by hand |
| A cache falls back to another store and reports `cache.degraded` / `cache.recovered` | Custom circuit-breaking around the cache |

## Coordination & data integrity

| With Telo | Without it |
| --- | --- |
| `Sql.Transaction` is an ambient zone; nested ones join; a throw rolls back | A transaction object threaded through every function |
| Transaction rules checked on every path the analyzer can see, the runtime refusing the rest (`ERR_ZONE_REQUIRED`): a statement needing a transaction reached without one (`ZONE_REQUIREMENT_UNSATISFIED`), a durable wait inside a lock (`ZONE_ATTRIBUTE_VIOLATED`) | Non-transactional writes found in an incident review; a lock held for days |
| `Idempotency.Once`: atomic claim, replayed result, released on failure; a repeated workflow `runId` attaches | Idempotency keys, a cache, a lock and dedup tables |
| `Lease.Critical`: acquire, run and release, `ttl`, fail-closed, holder-guarded | Distributed-lock code with stuck-lock bugs |
| Journal writes commit in the business transaction, and each region logs which regime it got (`durable.zone.mode`) | An exactly-once claim nobody can verify |
| Atomic `putIfAbsent` / `compareAndSet`; a lost race is `null`, not an exception | Get-then-set races |
| `RateLimit.Guard` / `Budget` verdicts over any cache | Hand-rolled token buckets |
| Inbound work starts with no inherited transaction or trace | Context leaking across requests |
| One OAuth refresh per grant at a time | Revoked grants from concurrent refreshes |

## Streaming & I/O

| With Telo | Without it |
| --- | --- |
| `mode: stream` + an encoder: backpressure, a client disconnect cancels the upstream call, mid-stream failures written in-band | Hand-wired streams that fail silently |
| Writes are atomic: `Fs.FileWrite` renames into place, `Blob.Put` replaces whole, an over-size write stores nothing | Temp-file-and-rename logic |
| `Stream.Chunk`, `Stream.Tap`, lazy `Run.Iteration` | Buffering large sources in memory |
| Multipart and any declared content type arrive as a stream | A multipart parser to configure |

## Performance

| With Telo | Without it |
| --- | --- |
| Module layers and assets fetched lazily, only for kinds actually used and only for this platform | Downloading every platform's binaries |
| Seek cursors returning every row once, even while rows are inserted | OFFSET pagination that drifts and slows down |
| Concurrent agent tool calls, results in call order | A tool-call scheduler |

## Observability

| With Telo | Without it |
| --- | --- |
| Every invocation a span, incoming W3C `traceparent` continued; tracing turned on by listing one sink | Per-handler instrumentation; an OpenTelemetry SDK and propagation middleware |
| Every log record carries its resource and `scope`, and inside a dispatch its `trace_id` / `span_id` | Passing request IDs by hand |
| Standard operations logged with OpenTelemetry names: `http.server.*` with `http.route`, SQL with timing, retries, credential refreshes, agent spans with GenAI attributes | Log formats per library; invisible retries; custom LLM telemetry |
| Per-import log levels that cascade; a record's `scope` is the path you write to change it | Guessing logger names |
| Logging can't hurt the app: bounded sinks with counted drops, a log call never throws, `fatal` flushes, startup records replayed, errors never sampled | A log call failing a request; missing startup logs |
| Only listed sinks receive records; a library can't open one | Dependencies writing log files on your behalf |

## Security

| With Telo | Without it |
| --- | --- |
| Credentials redacted in logs, errors and traces: `secrets:` values, `Telo.Url` passwords, sensitive need fields, `x-telo-sensitive` contract fields; need variables hidden from the process environment and from children | A hand-kept redaction list; database passwords in error messages |
| Spans carry no payloads unless a contract field opts in (`x-telo-span-attribute`); no request headers, SQL parameters, URL queries or LLM message content are logged | Payloads and signed URLs leaking into logs and traces |
| `!sql` binds every hole as a parameter | Remembering parameterized queries |
| Downloads verified: import pins, layer digests, revalidated mutable tags, `sha256`-pinned `https`-only staged files, checksummed engines and runner binaries; archive paths escaping a module refused | Trusting what a registry serves today; install scripts fetching unpinned binaries |
| Secrets never packaged or indexed; a published contract exposes only a secret's type | Credentials in artifacts |
| A secret or sensitive need field read from an env file `env.files` does not mark sensitive is warned at `telo run`, and on its row in Studio's Variables tab | A password committed in `.env`, unnoticed |
| Sensitive env files (`.env.local` by default, else the `env.files` entries marked `sensitive`, by the nearest `telo-workspace.yaml`) never synced to Telo Cloud or into an agent's session | A `.gitignore` line someone forgets; secrets copied into a sandbox |
| A mount `guard:` runs after CORS and before body parsing, and never fails open | Auth middleware ordering bugs |
| `OAuthClient`: PKCE, `iss` checks, single-use sign-ins, tokens never logged | Hand-implemented OAuth details |
| `Shell.Command` `args:` run with no shell; `env: {X: null}` unsets an inherited secret | Command injection; secrets inherited by child processes |
| Host and client identity trusted only when declared: `unknownHosts: reject` → 421, forwarded headers off by default | DNS-rebinding checks; a spoofable client IP |
| Untrusted content handled safely: allowlist HTML sanitizing, `Image.Fit` sizing before decode and stripping metadata, `Blob.Key` refusing `../x` | Regex scrubbing; decompression bombs; path traversal |
| `Ai.Agent` `approval:` gates tool calls | Hand-built human-in-the-loop |
| `TELO_EGRESS=public-only` refuses module fetches to private hosts | A hand-written SSRF guard |

## Time & scheduling

| With Telo | Without it |
| --- | --- |
| `Durable.Sleep` / `Durable.Await` wait for days holding nothing; deliveries type-checked | Polling tables and a job queue |
| `Schedule.Interval` / `Schedule.Cron` with timezone and `when:`; failing ticks re-arm, ticks never overlap, teardown waits for the tick in flight | A cron library; jobs that die, stack up or are abandoned on shutdown |
| `Watch.Wait` / `Watch.Publish` long polling with capped timeouts | Long-poll plumbing |

## Testing

| With Telo | Without it |
| --- | --- |
| Tests are manifests run by the kernel you deploy; `Assert.Equals` is a step | A test framework mocking the runtime |
| Tests start their own containers — readiness-waited, loopback-only, always removed — unchanged locally, in CI or in a runner session | Compose files; CI service blocks; leaked containers |
| Tests run the real wiring: `App.Instance` runs the application file, `include:` partials are shared | An importable app factory; fixtures drifting from production |
| `Assert.Events` matches kernel events as a subsequence or counts them (`times: 0` for "never") | Spies inside the code under test |
| In-memory stores and `:memory:` SQLite run the production code path | Mocking the store layer |
| `Benchmark.Suite` fails CI on `p99` thresholds | A load-testing tool wired into the pipeline |
| `Channel.SendLine` / `Channel.ReadUntil` drive an interactive app with bounded reads | expect-style scripting |

## Packaging & delivery

| With Telo | Without it |
| --- | --- |
| No install step: `telo run` fetches each import on first use, verified against its pin, and only the parts this machine needs — under `--watch` too, so an import added while editing is fetched on the next reload; an app has no package manifest, dependency directory or lockfile of its own | An install step before every run, and a restart after adding a dependency; a dependency tree and lockfile to maintain |
| `telo package`: one executable that needs no telo and no network, refusing a payload that would be incomplete; `telo package inspect` | A runtime to install on the target, or an image to build |
| Runners run a manifest with no image build; watch sessions reload | An image built and pushed per change |
| `telo run oci://…@<version>#sha256-<pin>` runs a published app, verified first | Pull, unpack, install |
| One module at incompatible versions in one app is refused (`MODULE_VERSION_CONFLICT`) | Two copies of a library at different versions loaded side by side |
| `telo upgrade` and import CodeLenses move pins only to versions your runtime can read, re-pin them, and report what they held back | Upgrades past what production can run |
| `telo install` warms `.telo/`, so the tree boots offline | Dependencies pulled at boot |

## For module authors

| With Telo | Without it |
| --- | --- |
| Kind authors state cross-field and referrer rules, checked statically (`RESOURCE_RULE_VIOLATED`, `REFERRER_RULE_VIOLATED`) | Controller guards that fire only at runtime |
| Templated definitions checked like any manifest, a forwarded value's error reported on the consumer's line | A composite component whose inner wiring fails at request time |
| The kernel bundles TypeScript controllers and `exports.browser:` entries; `telo publish` uses the same builder | Bundler configs; stale committed bundles |
| Rust controllers built on load, the kernels that can host a kind derived from its `controllers:`; `native:` files declared once, a miss naming every shipped platform | FFI glue; prebuild loaders; "module not found" on an unexpected platform |
| A module declares the telo it needs (`requires: telo:`); a consumer on an older runtime gets one `MODULE_REQUIRES_NEWER_RUNTIME`, and ranges are verified at their edges on publish | Consumers blaming a module for version skew; compatibility claims nobody tests |
| `telo publish`: an OCI artifact at `metadata.version`, annotations, `--dry-run`, JSON outcomes; an unpinned import or changed contents at a published version refused | Release scripts; a version silently changing under consumers |
| `telo release`: digest-driven bumps propagated with reasons, every version file and `Cargo.lock` written, colliding destinations refused | Hand-decided bumps; a forgotten lockfile; an overwritten artifact |
| `Assert.Manifest` asserts the exact diagnostics a manifest produces, and can run it to prove both verdicts agree | Shell scripts around the CLI |
| `telo changed` lists the tests a diff reaches | Hand-written CI path filters |
| Reproducible layer archives | Builds differing by clock or path |
| `telo release add` writes changelog fragments; `CHANGELOG_ENTRY_REQUESTED` warns on a changed module with none | Hand-kept CHANGELOG files |
| A module root's `LICENSE` and upstream notices shipped automatically | Remembering license files in packaging config |
