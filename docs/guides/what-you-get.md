---
description: "The features a Telo application gets without writing them — request cancellation, graceful shutdown, configuration you can see, checks a compiler cannot make — and what the standard library adds on top."
---

# What you get for free

What a Telo application gets without writing it, compared with TypeScript, Go
or Java and their usual libraries. **Telo itself** is what every application
gets, whatever it imports. **Standard library** is what its modules add.
Within each group, the features people ask about most come first. The page
grows with every release.

## Telo itself

### Running

- **Request cancellation.** When a caller goes away — a client disconnecting, a timeout, a shutdown — cancellation flows down everything the call started, to every call that honours it, retry backoffs included. No cancellation token passed through every function.
- **Graceful shutdown.** `SIGINT` / `SIGTERM` cancel in-flight work, refuse what has not started, close resources in reverse dependency order, wait briefly for background work, flush logs last, and exit with a defined code — the same in a packaged binary. A cleanup that fails does not stop the rest.
- **Timeouts that cancel.** A per-attempt `timeout:` on any call cancels it rather than abandoning it with its side effect still running.
- **Safe retries.** `retry:` on any call, with exponential backoff and full jitter. Cancellations and contract violations are never retried, `nonRetryable:` stops on named codes, a retry that would resend a consumed stream is refused before the app runs, and a cancelled backoff keeps the original failure.
- **Starts and stops itself.** Startup order comes from the references between resources, and a dependency loop is reported with its path before anything starts. The process stays up while something serves or schedules and exits when the work is done; one stuck waiting on something that can never happen exits 1 with the reason.
- **Validation on every call.** A resource's `inputType` / `outputType` are checked at runtime on every call between resources, not only at the HTTP edge.
- **No context leaking between requests.** Inbound work starts with no inherited transaction or trace.

### Configuration

- **See what an app needs.** `--help` lists every argument and every environment-only input with its type and default; `telo needs report` lists the variables its dependencies read; `telo module manifest --json` reports all of it; `telo env template` writes the `.env` / `.env.local` lines. Nothing is booted for any of them.
- **See what an app does.** `telo describe` says what an application does without running it: the environment variables and arguments it reads and which fields read each, what it starts, every route, schedule and consumer with what it runs, which `catches:` entry renders each error it can throw, and what nothing reaches. `-o json` gives the same as a versioned document.
- **Validated before start.** Inputs are declared once with `env:` and `type:`, and every missing or invalid one is reported together before anything starts. A declared variable reads as unset through the process environment, so code reading it directly gets nothing.
- **Asked for at the terminal.** `telo run` at a terminal asks for each input nothing supplies — a secret without echo, each answer checked as the environment variable would be and asked again with the reason when refused — then offers to save the answers to `.env` / `.env.local`. A watch session asks once; nothing is asked under `--no-input`, in a runner or without a terminal.
- **Dependency settings without inventing names.** A library's settings are read from derived names (`TELO_NEED_ORDERS__DATABASE_ACCESS__URL`); a missing one names every variable to set; two settings reading one variable are refused; a stated `version:` or `features:` is checked against what the dependency finds at start.
- **Libraries can't read your environment.** Only the application reads environment variables and arguments; a library declaring one is refused, and receives values from its importer instead.
- **Command-line arguments.** `arg:` turns an input into a flag or positional, with one precedence (argument, then environment, then `default:`) and unknown arguments refused. A secret can never be an argument.
- **`.env` files.** `.env` and `.env.local` are collected up to the workspace marker by `telo run` and Studio alike. `.env` may be committed; `.env.local` holds secrets.
- **Persistent storage without a path in the manifest.** A `Telo.DurableDirectory` need asks for a directory that survives restarts and redeployments, with a minimum `size` and `single-writer` or `shared` access. A host mounts one per need, or sets `TELO_HOST_STATE_DIR` once and every need gets its own directory under it; a directory the app cannot write to, or a rename that would strand the old one's files, is refused before anything starts.
- **Public URLs without hard-coding.** `Telo.PublicUrl` is derived from host templates, so no domain is written in a manifest; two addresses no host could route apart are refused at start.
- **Paths that don't depend on the working directory.** A relative path in configuration is refused before the app runs, and files a module ships are found wherever it is unpacked and checked to exist. A path slot says whether it takes a file or a directory (`entry: directory`), so a file wired where a directory is wanted is refused before the app runs, or at start when the path comes from the environment.
- **Ports known before boot.** `ports:` are typed TCP or UDP and known to a runner before the app starts.

### Checked before it runs

- **Static checking.** `telo check` resolves every import, reference, schema and expression with no database, network or process — the configuration, wiring and query mistakes a compiler cannot see. Malformed URLs, regexes, durations and cron expressions are refused too. It exits non-zero on errors only, and `-o json` gives each finding with its location, code and fix.
- **The runtime agrees with the checker.** `telo run` runs the same analysis and refuses to start, with the same message.
- **Error coverage.** Each error code a handler declares must be rendered by a `catches:` entry around it; a catch for a code nothing throws and a missing or misplaced catch-all are refused. Wrappers pass their body's codes through (`throws: { inherit: true }`), and errors are coded and typed rather than matched on message text.
- **Wiring checked.** Every reference must resolve to a resource of the kind its slot accepts.
- **Texts checked for translation.** Text shown to a person is typed `Text` and written in the module's `lang:`, with `{$name}` placeholders and plural cases chosen by the language's CLDR rules. A text that does not parse, a plural case its language lacks, a value a text reads that the call does not give, a placeholder the screen or controller that shows the text will not fill, an expression where a text must be written at the call, and a translation reading a placeholder its source lacks are refused before the app runs, and the same mistakes in a computed text when it is computed, at start or per call; a translation nothing shows is warned about. Each controller receives the text with the language it is written in.
- **Security settings that would do nothing are refused.** A sensitive mark no contract reaches, a redaction path that does not parse, a version requirement nothing compares.
- **Failures point at the cause.** A failed start reports the root cause first, with the resources it blocked collapsed under it and the manifest location named.

### Observability and security

- **Tracing.** Every call is a span and an incoming W3C `traceparent` is continued. Tracing turns on by listing one sink.
- **Structured logging.** Every record carries its resource and `scope`, and inside a call its `trace_id` / `span_id`. Levels are set per import and cascade. A log call never throws, sinks are bounded with dropped records counted, `fatal` flushes, and only sinks the application lists receive anything.
- **Secret redaction.** `secrets:` values, URL passwords, sensitive dependency settings and contract fields marked `x-telo-sensitive` are redacted in logs, errors and traces. Spans carry no payloads unless a contract field opts in (`x-telo-span-attribute`).
- **Secrets stay where they belong.** Never packaged or indexed; a published contract shows only a secret's type. A secret read from an env file not marked sensitive is warned about at `telo run` and in Studio's Variables tab, and sensitive env files are never synced to Telo Cloud or into an agent's session.
- **Verified downloads.** Import pins, layer digests, revalidated mutable tags, pinned `https`-only staged files and checksummed binaries; an archive path escaping its module is refused.
- **Egress guard.** `TELO_EGRESS=public-only` refuses module fetches to private and loopback hosts.

### Delivery

- **No install step.** `telo run` fetches each import on first use, verified against its pin, and only the parts this machine needs — under `--watch` too, so an import added while editing is fetched on the next reload. An app has no package manifest, dependency directory or lockfile of its own.
- **One executable.** `telo package` produces a file that runs with no telo and no network, and refuses to write one that would be incomplete. The file is also the telo that runs it: `telo describe ./orders` reads it from any installed telo, and `TELO_APP_CLI=1 ./orders describe ./orders` (or `check`, or `run --inspect --debug`) describes, checks or runs it with live inspection where it is deployed.
- **Run a published app by reference.** `telo run oci://…@<version>#sha256-<pin>`, verified before anything runs.
- **No image per change.** Runners run a manifest without building an image, and watch sessions reload on edit.
- **Offline boot.** `telo install` warms `.telo/`, so the tree boots with no network.
- **Upgrades your runtime can read.** `telo upgrade` and the editor's import CodeLenses move pins only to versions your telo can run, and report what they held back.
- **One version of each module.** A module imported at incompatible versions is refused before the app runs.
- **Downloads only what's used.** Module layers and assets are fetched lazily, for the kinds actually used and this platform only.

### Editing and extending

- **Write your own modules.** When the standard library lacks something, write a module beside your app — controllers in TypeScript or Rust — and import it by relative path. No build step: TypeScript is bundled from source when the app loads and Rust is built from its crate (with `cargo` installed). Its kinds' schemas, references and contracts are checked like the standard library's, and publishing it later changes only the import's `source:`. See [`examples/local-modules`](https://github.com/telorun/telo/tree/main/examples/local-modules) for a TypeScript and a Rust module racing on the same job.
- **Visual editing.** Studio shows Topology, Inventory, Source and Deployment views over the YAML on disk, with edits going both ways.
- **Editor and runtime on one version.** The editor runs the exact engine of the telo version the module's `requires: telo:` selects, and the local runner runs that same release.
- **Coding agents know the modules.** The hub's MCP server gives agents `search_resources`, `get_kinds` with exact pins and schemas, and authoring guides.

## Standard library

**Secure by default.** The standard library's modules ship with their protective settings on: request and read limits enforced, guards and locks that fail closed, SQL parameters always bound, commands run without a shell, secrets and tokens kept out of logs. Each module is a pinned, integrity-checked artifact.

### HTTP server

- **Request validation.** `request.schema` checks body, query, path and headers before the handler runs, converting query and path values to their declared types, with a standard 400 envelope.
- **Error rendering.** Thrown codes are rendered through `catches:` on the route, then `Http.Api`, then `Http.Server`, then a built-in 500, with `error.data` typed per code.
- **Streaming responses.** `mode: stream` with an encoder (NDJSON, SSE, plain text): backpressure, a client disconnect cancels the upstream call, and a mid-stream failure is written in-band.
- **OpenAPI.** Built from the mounted routes; `Http.Reference` serves a browsable page offline, listing only the routes the requesting host can reach.
- **Body limits.** `maxBodyBytes` (1 MiB default, always on) and multipart limits are enforced while reading.
- **Auth guards.** A mount `guard:` runs after CORS and before the body is parsed, and never fails open.
- **Host routing.** `unknownHosts: reject` answers foreign hosts with 421; forwarded headers and client IP are trusted only when declared.
- **No silent route shadowing.** Duplicate routes and MCP tool names are refused.
- **Content negotiation.** `Accept` negotiated per RFC 9110, with `406` listing what is available.

### HTTP client

- **Resilient by default.** Retries on 408/429/5xx and network failures, `Retry-After` honoured, a 10 s default timeout, network errors normalized to one set of codes.
- **Credential refresh.** A 401 refreshes the credential and retries once.
- **No empty resends.** A streamed body is never re-sent as an empty one.

### SQL

- **Ambient transactions.** Every statement reached through a `Sql.Transaction` joins it at any depth; nested transactions join the outer one; a throw rolls back.
- **Transactions checked on every path.** A statement that requires a transaction is checked on every path the analyzer can see before the app runs, the runtime refusing the rest; a durable wait inside a transaction or lease is refused.
- **Declarative schema.** `Postgres.Schema` / `SQLite.Schema` bring the database to the declared tables at boot, under an advisory lock, one transaction per batch, touching only objects they declare.
- **Safe schema changes.** Removals wait for `reclaim:`, renames go expand-contract (`renamedFrom:`), and changes it detects as unsafe — narrowing a type, `NOT NULL` over existing NULLs — are refused before any DDL.
- **Parameterized by construction.** `!sql` binds every hole as a driver-native parameter.
- **Typed rows.** A declared table projects its row, so seed rows, filters and keys are checked against its columns.
- **Portable enums.** One declaration becomes a native type on PostgreSQL and a `CHECK` on SQLite.
- **Self-healing connections.** Postgres pools probe and replace dead connections; `LISTEN` re-subscribes after reconnecting.

### CRUD

- **Models instead of DTOs.** `Crud.Model` gives four shapes — read, list, create, update — checked for consistency.
- **Safe list queries.** Only declared filters and sorts are accepted, `limit` / `sort` / `cursor` are validated, and seek cursors return every row once even while rows are inserted.

### User interfaces

- **Screens that follow their data, with no frontend code.** A `Ui.Data` reads a record when its page is drawn — a loading state first, a failure state for a refused read, again on window focus or when a request inside it answers 401 — and a node's `shown` condition decides in the browser what is drawn from the answer, the page's query parameters or a form's values; hidden content keeps what was typed and requests nothing. A sign-in gate is a reader and two conditions. A condition that can never hold for the value it reads, or that reads a value its place does not hold, is refused before the app runs.
- **Forms with lookups, date ranges and remembered values.** A form's fields are kinds: a choice or a picker over options read from your API — searched as the viewer types, paged as the list scrolls, chosen values labelled by one lookup, narrowed by other fields of the form — a date range with presets such as this month or last quarter in the viewer's time zone, and sliders, switches and tags. Fields are grouped into labelled sections, checked against the model as values are typed with the server's refusals shown on the field they name, and kept in the page address or the browser's storage across visits (`state:`). A field whose control or options do not fit its property — from `ui` or from any other module — is refused before the app runs.
- **Swappable themes, with your brand on top.** `theme:` on a `UiReact.App` picks the look of every screen — `UiReact.defaultTheme`, `Radix.theme` from `ui-react-radix` with its selects, menus and dialogs drawn by Radix, or a theme of your own — so switching it restyles every screen and swaps its selects, menus and dialogs at once, while your brand stays in `tokens:` and applies over any theme, light and dark. A module publishing a theme holds it to the renderer's contract from its own tests with `UiReactConformance.CheckTheme`: every element styled, no layout rule the screens rely on overridden, every control's keyboard, focus and dismissal behaviour met.
- **Buttons that answer in place, with no double submits.** A `Ui.Action` draws a success as its `result:` tree and any failure — a refusal, a 401, no answer at all — as its `failure:` tree, then reloads every reader and table over the paths `onSuccess.refreshes` names and moves the page where `onSuccess.navigate` says. A form or a row takes no second press while its first is pending, `concurrency: serial` runs presses one after another, and a table's or a list's row draws the answer of its action — a download link, a status — in place of its button. A row's inputs that cannot make a valid request are refused before the app runs.
- **Screens in the viewer's language.** Give `UiReact.App` a `translator:` and a `lang:` read from `Accept-Language` or a cookie, and every page title, label, model title, enumeration label and built-in word is served translated, with plurals and numbers formatted in the browser by the language's rules and a heading over data composed from the values it names (`{ text, values }`). Each language is one cached document with `Vary` naming exactly the headers read.

### Durable execution

- **Crash recovery.** Durable runs record each step and decision; a restart resumes where the work stopped.
- **Durability that can't break silently.** Swallowed suspensions are detected, a replay reaching a different step is refused, and `now()` / `uuidv4()` inside a replayed region are refused before the app runs.
- **Waiting for days.** `Durable.Sleep` / `Durable.Await` hold no process, connection or timer; a delivery is checked against its type.
- **Timing that survives restarts.** Long backoffs park with their attempt count, deadlines are fixed on the first pass, and missed schedules are found due.
- **Exactly-once with the database.** With the journal on the business connection, journal writes commit in the same transaction, and each region logs which regime it got (`durable.zone.mode`).

### Coordination

- **Idempotency.** `Idempotency.Once` claims atomically, replays the stored result on repeats and releases on failure; a repeated workflow `runId` attaches to the existing run.
- **Distributed locks.** `Lease.Critical` acquires, runs and releases, expires on `ttl`, fails closed on an empty key and guards release by holder.
- **Race-free key/value.** `putIfAbsent` / `compareAndSet` are atomic, and a lost race is `null`, not an exception.
- **Rate limiting.** `RateLimit.Guard` and `RateLimit.Budget` return `{ allowed, remaining, retryAfter }` over any cache store.

### Caching

- **Stale-while-revalidate.** `Cache.View` revalidates in the background with single-flight, or synchronously, and serves stale on error.
- **Degraded mode.** A cache falls back to another store and reports `cache.degraded` / `cache.recovered`.

### Scheduling

- **Schedules.** `Schedule.Interval` and `Schedule.Cron` with a timezone and a per-tick `when:`; a failing tick re-arms, ticks never overlap, and shutdown waits for the tick in flight.
- **Long polling.** `Watch.Wait` / `Watch.Publish` with capped timeouts.

### Translation

- **Translated texts.** `I18n.Catalog` holds one language's translations and `Self.t(text, lang, values)` formats a text in the language asked for — falling back from `pl-PL` to `pl` to the source, with numbers and plural cases by the language's CLDR rules and no ambient locale; a text translated twice in one language across a translator's catalogs is refused before the app runs.
- **Language negotiation.** `I18n.Negotiator` answers the language to reply in from an `Accept-Language` value, by quality and RFC 4647 lookup over the catalog languages and a default, skipping malformed ranges instead of failing the request.

### Files and streams

- **Atomic writes.** `Fs.FileWrite` renames into place and `Blob.Put` replaces whole; an over-size write stores nothing.
- **Streams without buffering.** `Stream.Chunk`, `Stream.Tap` and lazy `Run.Iteration`; multipart bodies arrive as a stream.

### Testing

- **Tests run the real app.** `App.Instance` runs the application file itself, and tests are manifests run by the kernel you deploy.
- **Containers on demand.** Tests start their own containers — readiness-waited, loopback-only, always removed — unchanged locally, in CI or in a runner session.
- **Assert on what happened.** `Assert.Events` matches kernel events as a subsequence or counts them (`times: 0` for "never").
- **No store mocks.** In-memory stores and `:memory:` SQLite run the production code path.
- **Benchmarks in CI.** `Benchmark.Suite` fails the build on `p99` thresholds.
- **Interactive apps.** `Channel.SendLine` / `Channel.ReadUntil` drive one step by step, with bounded reads.

### Auth and untrusted input

- **OAuth.** `OAuthClient`: PKCE on, `iss` checked, single-use sign-ins, one refresh per grant at a time, tokens never logged.
- **Shell commands.** `Shell.Command` `args:` run with no shell; `env: {X: null}` unsets an inherited secret.
- **Untrusted content.** Allowlist HTML sanitizing, `Image.Fit` sizing before decoding and stripping metadata, `Blob.Key` refusing `../x`.

### AI

- **Human approval.** `Ai.Agent` `approval:` gates tool calls.
- **Bounded agents.** `maxSteps` caps model calls and `maxToolResultBytes` caps each tool result, with an explicit truncation marker.
- **Concurrent tool calls.** Run concurrently, results returned in call order.
- **One error set per provider family.** Every model provider — and every search, OCR, graph and MCP client — reports one closed set of codes, with `retryAfterSeconds`.
- **Vector dimensions.** Enforced at insert and query.

## For module authors

- **Rules for your kinds.** State cross-field and referrer rules as data, checked before the app runs.
- **Templated definitions.** Checked like any manifest; an error in a forwarded value is reported on the consumer's line.
- **Typed node trees.** A kind whose schema is a recursive node tree (`$ref` to a named shape) gets every expression in it typed and evaluated at every depth, a nested `x-telo-context` adding its names to the enclosing one; a condition's schema that can never hold for the value it names (`x-telo-match-for`) is refused before the app runs.
- **No bundler config.** The kernel bundles TypeScript controllers and `exports.browser:` entries; `telo publish` uses the same builder.
- **Native controllers.** Rust controllers build on load, the kernels that can host a kind are derived from its `controllers:`, and `native:` files are declared once.
- **Runtime requirements.** `requires: telo:` gives a consumer on an older runtime one clear "runtime too old" error instead of errors blamed on their manifest, and ranges are verified at their edges on publish.
- **Publishing.** `telo publish` pushes an OCI artifact at `metadata.version`; an unpinned import or changed contents at a published version are refused.
- **Releases.** `telo release` decides bumps from payload digests, propagates them with reasons, writes every version file and `Cargo.lock`, and `telo release add` writes changelog fragments.
- **Diagnostics tests.** `Assert.Manifest` asserts the exact diagnostics a manifest produces, and can run it to prove both verdicts agree.
- **Test selection.** `telo changed` lists the tests a diff reaches.
- **Reproducible artifacts.** Layer archives are a pure function of their files; the module's `LICENSE` and upstream notices ship automatically.
