---
description: "The features a Telo application gets without writing them — request cancellation, graceful shutdown, configuration you can see, checks a compiler cannot make — and what the standard library adds on top."
---

# What you get for free

What a Telo application gets without writing it, compared with TypeScript, Go
or Java and their usual libraries. **Telo itself** is what every application
gets, whatever it imports. **Standard library** is what its modules add.
Within each group, the features people ask about most come first. The page
grows with every release.

## In plain terms

If you are weighing Telo rather than building with it, these are the things your
team does not have to build or remember, each described in detail below:

- **Mistakes are caught before the app runs.** Wrong wiring, wrong value types and unhandled errors are reported with the place to fix, not discovered in production.
- **Shutdown and cancellation behave.** When a user disconnects or the app is stopped, in-flight work is cancelled and cleaned up in a defined order.
- **Retries and timeouts are safe.** A failing call can be retried with backoff, and a call that times out is stopped rather than left running.
- **Work survives a crash.** Durable runs record each step, so a restart continues where it stopped, including waits of days.
- **Configuration is visible.** The app lists every setting it needs, reports all missing ones together before starting, and keeps secrets out of logs.
- **Logging and tracing are built in.** Structured logs and traces carry the same ids, with no code to write.
- **Every change is a readable file diff.** Applications are plain files in Git, so review, sign-off and rollback use the tools you already have.

## Telo itself

### Running

- **Request cancellation.** When a caller goes away — a client disconnecting, a timeout, a shutdown — cancellation flows down everything the call started, to every call that honours it, retry backoffs included. No cancellation token passed through every function.
- **Graceful shutdown.** `SIGINT` / `SIGTERM` cancel in-flight work, refuse what has not started, close resources in reverse dependency order, wait briefly for background work, flush logs last, and exit with a defined code — the same in a packaged binary. A cleanup that fails does not stop the rest.
- **Timeouts that cancel.** A per-attempt `timeout:` on any call cancels it rather than abandoning it with its side effect still running.
- **Safe retries.** `retry:` on any call, with exponential backoff and full jitter. Cancellations and contract violations are never retried, `nonRetryable:` stops on named codes — one the target cannot throw is flagged before the app runs — `retryAfter:` waits as long as the failure itself asks, a retry that would resend a consumed stream is refused before the app runs, and a cancelled backoff keeps the original failure.
- **Error messages for people, apart from the developer's.** An error carries two messages: `message` for logs and traces, and `displayMessage`, the text a person is shown — declared once per code (`throws.codes.<CODE>.displayMessage`, its placeholders filled from the error's `data`) or written on a `throw` step — attached whenever the declaring kind's code is thrown, and checked like every other text before the app runs. `rethrow: {}` re-raises a caught error unchanged, and an error thrown while handling another keeps the caught one as its cause in the log record. The runtime's own failures — a request that is not valid, a result that could not be delivered — carry display messages translated into fourteen languages, shown in each language the application serves with no catalog listed, and reworded by any catalog of your own.
- **Starts and stops itself.** Startup order comes from the references between resources, and a dependency loop is reported with its path before anything starts. The process stays up while something serves or schedules and exits when the work is done; one stuck waiting on something that can never happen exits 1 with the reason.
- **Validation on every call.** A resource's `inputType` / `outputType` are checked at runtime on every call between resources, not only at the HTTP edge.
- **No context leaking between requests.** Inbound work starts with no inherited transaction or trace.

### Configuration

- **See what an app needs.** `--help` lists every argument and every environment-only input with its type and default; `telo needs report` lists the variables its dependencies read; `telo module manifest --json` reports all of it; `telo env template` writes the `.env` / `.env.local` lines. Nothing is booted for any of them.
- **See what an app does.** `telo describe` says what an application does without running it: the environment variables and arguments it reads and which fields read each, what it starts, every route, schedule and consumer with what it runs, which `catches:` entry renders each error it can throw, and what nothing reaches. `-o json` gives the same as a versioned document.
- **Validated before start.** Inputs are declared once with `env:` and `type:`, and every missing or invalid one is reported together before anything starts. A declared variable reads as unset through the process environment, so code reading it directly gets nothing.
- **One app on several backends, chosen by its environment.** `!if` and `!switch` pick a resource, a field or a start-up target from an input: the presence of a secret, an `enum` or boolean variable, or the scheme of a database URL (`DATABASE_URL=postgres://…` or `sqlite://…`). Only the chosen branch is created and only its module's controller loads. `telo check` checks every combination of those inputs and says which one a finding holds in (`(when variables.dialect is postgres)`), so a branch you never run locally is checked too.
- **Asked only for what the chosen setup uses.** An input or dependency setting that only some choices read is required only when the application starts in one of them: an app using OpenAI when `OPENAI_API_KEY` is set and Anthropic otherwise boots on either key alone, and a missing one names just the variables that setup needs. `--help` and `telo needs report` say when each is required (`required when OPENAI_API_KEY is unset`), and the terminal prompt asks for nothing else.
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
- **Texts checked for translation.** Text shown to a person is typed `Text` and written in the module's `lang:`, with `{$name}` placeholders and plural cases chosen by the language's CLDR rules. A text that does not parse, a plural case its language lacks, a value a text reads that the call does not give, a placeholder the screen or controller that shows the text will not fill, an expression where a text must be written at the call, and a translation reading a placeholder its source lacks are refused before the app runs, and the same mistakes in a computed text when it is computed, at start or per call; a translation nothing shows is warned about, and so is every text and every library key that a language the application serves has no translation for, listed per language before the app runs. Each controller receives the text with the language it is written in.
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
- **No image per change.** Runners run a manifest without building an image, and `telo run --watch` reloads on edit. Each reload runs as a plain run would: an app that finishes is torn down and reports its exit code, then the next edit runs it again; a server keeps serving until the next change.
- **Offline boot.** `telo install` warms `.telo/`, so the tree boots with no network.
- **Upgrades your runtime can read.** `telo upgrade` and the editor's import CodeLenses move pins only to versions your telo can run, and report what they held back.
- **One version of each module.** A module imported at incompatible versions is refused before the app runs.
- **Downloads only what's used.** Module layers and assets are fetched lazily, for the kinds actually used and this platform only.

### Editing and extending

- **Write your own modules.** When the standard library lacks something, write a module beside your app — controllers in TypeScript or Rust — and import it by relative path. No build step: TypeScript is bundled from source when the app loads and Rust is built from its crate (with `cargo` installed). Its kinds' schemas, references and contracts are checked like the standard library's, and publishing it later changes only the import's `source:`. See [`examples/local-modules`](../../examples/local-modules) for a TypeScript and a Rust module racing on the same job.
- **Visual editing.** Studio shows Topology, Inventory, Source and Deployment views over the YAML on disk, with edits going both ways.
- **Editor and runtime on one version.** The editor runs the exact engine of the telo version the module's `requires: telo:` selects, and the local runner runs that same release.
- **A workspace that keeps running while you edit apps.** On the Kubernetes runner, adding, removing or re-versioning an application in a session does not restart the workspace or its authoring agent, and each application can still run its own telo release.
- **Coding agents know the modules.** The hub's MCP server gives agents `search_resources`, `get_kinds` with exact pins and schemas, and authoring guides.

## Standard library

**Secure by default.** The standard library's modules ship with their protective settings on: request and read limits enforced, guards and locks that fail closed, SQL parameters always bound, commands run without a shell, secrets and tokens kept out of logs. Each module is a pinned, integrity-checked artifact.

### HTTP server

- **Request authentication with a typed caller.** A mount's `authentication:` lists verifiers in order, each reading its credential from where it is sent (`Http.FromAuthorization`, `FromHeader`, `FromCookie`, `FromClientCertificate`, …), and handlers read the caller as `request.principal`. A malformed or refused credential is a 401 carrying every challenge and is never served as anonymous; a missing one is a 401 unless the mount or route allows anonymous callers; an `authorization:` policy's denial is a 403 naming the missing scopes. `request.principal` is typed per route, so reading it unguarded on a route allowing anonymous callers is refused before the app runs, and so is a server that leaves one mount open while others authenticate. Bearer JWTs (against your own keys or another issuer's), opaque tokens checked by introspection, DPoP-bound tokens, HTTP Basic over declared users and a trusted proxy's asserted identity all plug into the same `authentication:` list.
- **Protected-resource discovery for MCP.** A mount's `protectedResource:` publishes the OAuth protected-resource metadata (RFC 9728) clients look for after a 401, with the authorization servers taken from the verifiers' issuers rather than written a second time, and every 401 from the mount names it. An MCP endpoint served behind authentication that denies anonymous callers without it is refused before the app runs.
- **Protection against cross-site request forgery.** A request authenticated by a cookie that changes state must come from the site itself or an origin listed in `trustedOrigins` (`Sec-Fetch-Site`, then `Origin`), or it is refused 403. There are no tokens to thread through forms, and the same request authenticated by a bearer token is not checked.
- **Standard API error responses.** Every error the server answers by itself — a throw no `catches:` entry claims, an entry with no `body:`, an over-size body, an unknown host, a refused `Accept`, a refused request — is an RFC 9457 problem (`application/problem+json`) carrying the error's `code`, its `data` and, where one is declared, its `detail` text. The developer message is never sent: it stays in the logs and the trace, and a plain crash answers only its status.
- **Request validation.** `request.schema` checks body, query, path, headers and cookies before the handler runs, converting query, path and cookie values to their declared types. A refusal is a 400 problem listing each finding as a pointer into the request plus the JSON Schema keyword it failed, with no validator prose, so a screen words it in the viewer's language — `ui-react` shows each on the field it names.
- **Error rendering.** Thrown codes are rendered through `catches:` on the route, then `Http.Api`, then `Http.Server`, then a built-in 500, with `error.data` typed per code.
- **Streaming responses.** `mode: stream` with an encoder (NDJSON, SSE, plain text): backpressure, a client disconnect cancels the upstream call, and a mid-stream failure is written in-band — or ended with a final record you declare, with `Stream.Recover`, the failure logged on the server.
- **OpenAPI.** Built from the mounted routes; `Http.Reference` serves a browsable page offline, listing only the routes the requesting host can reach.
- **Body limits.** `maxBodyBytes` (1 MiB default, always on) and multipart limits are enforced while reading.
- **Auth guards.** A mount `guard:` runs after CORS and before the body is parsed, and never fails open.
- **Cookies with checked, secure-by-default attributes.** A cookie is declared once — `HttpDispatch.HostCookie`, `SecureCookie` or `UnprefixedCookie`, HttpOnly and SameSite=Lax unless relaxed — and a response's `cookies:` sets it or clears it with `maxAge: 0s` under the same scope, so the browser really drops it. Handlers read `request.cookies`. A prefix, scope or SameSite combination a browser would reject, and a raw `Set-Cookie` header, are refused before the app runs; a computed value a cookie cannot carry fails the response instead of being sent mangled.
- **HTTPS and mutual TLS.** `tls:` on `Http.Server` serves HTTPS with a `minVersion` floor and asks for client certificates `required` or `optional`; handlers read `request.tls` and `request.clientCertificate` — subject, issuer, validity and whether the server verified it — and a failed handshake is logged with the client's address and the reason. Behind a TLS-terminating proxy, `forwardedClientCertificate` reads the certificate Envoy, nginx or Traefik forwards, and is refused before the app runs unless the proxy is trusted. Material that does not parse or match is refused at start.
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

- **Shapes instead of DTOs.** `Crud.Collection` gives the record `model` and three shapes — list, create, update — checked for consistency, and a relation that contradicts the table's foreign key is refused before the app runs.
- **Safe list queries.** Only declared filters and sorts are accepted, `limit` / `sort` / `cursor` are validated, and seek cursors return every row once even while rows are inserted.

### User interfaces

- **Links and requests built from data.** A link, a value, a column or a request names its target as `{ path, pathParams, queryParams }`: `/tasks/{id}` filled from `row.id`, percent-encoded, with query parameters in order and empty ones left out, or a `!ref` to a page, so renaming the page's path moves every link to it. A placeholder no `pathParams` entry fills, an entry no placeholder uses, and a name `row` does not have are refused before the app runs, and an address with an empty value is not followed. A link to the page being shown is marked as the current page (`aria-current="page"`, and `data-selected` on its record) with nothing to write.
- **Show a collection any way.** A `Ui.Listing` declares a collection's openers, row actions, filters and labels once, and its `layout` draws the records as a table, a list, cards, a board, a calendar, a timeline or a tree, with a `compact` layout below `compactBelow` that keeps an open form, paged with a pager, a "Load more" control or infinite scroll. Moving a card, rescheduling an event or reparenting a tree item runs an action you declare, and every listing over the same collection reloads. A listing can fix its order (`sort: { choosable: false }`) and fold its row actions into a menu when they do not fit (`rowActionsDisplay: auto`). A layout that needs a filter the API does not accept is refused before the app runs.
- **Filter and pick by related record.** Declare once that `posts.authorId` points at authors, and a listing shows the author's name instead of the key, a filter bar offers authors by name — optionally only those who have posts, with counts (`values: present`) — and a form enters the author with a picker. A relation that names a property the collection lacks, or a source for another collection, is refused before the app runs.
- **Screens that follow their data, with no frontend code.** A `Ui.Data` reads a record when its page is drawn — a loading state first, a failure state for a refused read, again on window focus or when a request inside it answers 401 — and a node's `shown` condition decides in the browser what is drawn from the answer, the page's query parameters or a form's values; hidden content keeps what was typed and requests nothing. A sign-in gate is a reader and two conditions. A condition that can never hold for the value it reads, or that reads a value its place does not hold, is refused before the app runs.
- **A chat page that offers only what the model takes.** `Ui.Chat` over a `Ui.ConversationSource` draws streamed replies, reasoning, tool and approval cards and branches, follows the page's `?conversation=` parameter (a new conversation's id is written back, and a link, back or forward switches), and shows the upload button only for the media types the model's `accepts` lists, within its size bounds — the same list the provider refuses outside of. A long conversation opens at its end, draws only the messages in view and reads earlier ones as the viewer scrolls up, keeping what they were reading in place. Pictures in a message open in a viewer with arrow-key browsing, and a `header:` of your own places a title and commands — export or copy the transcript, stop, new conversation — each offered and enabled by the chat itself. The list of conversations is not built in: a `Ui.Listing` over the contract's `Conversation.conversations` collection beside the chat, whose rows link to the conversation, show a badge while it replies and rename or delete through the contract.
- **A side panel that folds away.** `Ui.SplitView` places a list, a tree or a filter set beside any content; below `compactBelow` it becomes a drawer, a viewer can fold it on a wide screen and the choice is remembered across visits (`collapse.state`), and what is in it keeps its place — a listing stays on its page — and requests nothing while hidden.
- **Responsive navigation.** `navigation:` on a `UiReact.App` is a tree of pages, links and nested groups, each with an optional icon — a Lucide glyph from `ui-lucide` or an image of your own, drawn in the colour of its text — shown as a menu bar with dropdowns, a sidebar that collapses to a rail of icons and remembers its open groups (`Ui.SidebarNavigation`), and below `compactBelow` a menu button opening a drawer or a bottom tab bar (`Ui.TabBarNavigation`), with keyboard and screen-reader support. Entries name pages by reference, so a changed path moves the menu with it, and an entry naming a page the app does not serve, or a glyph the icon set does not have, is refused before the app runs.
- **Forms with lookups, date ranges and remembered values.** A form's fields are kinds: a choice or a picker over options read from your API — searched as the viewer types, paged as the list scrolls, chosen values labelled by one lookup, narrowed by other fields of the form — a date range with presets such as this month or last quarter in the viewer's time zone, and sliders, switches and tags. Fields are grouped into labelled sections, checked against the model as values are typed with the server's refusals shown on the field they name, and kept in the page address or the browser's storage across visits (`state:`). A field whose control or options do not fit its property — from `ui` or from any other module — is refused before the app runs.
- **Swappable themes, with your brand on top.** `theme:` on a `UiReact.App` picks the look of every screen — `UiReact.defaultTheme`, `Radix.theme` from `ui-react-radix` with its selects, menus and dialogs drawn by Radix, or a theme of your own — so switching it restyles every screen and swaps its selects, menus and dialogs at once, while your brand stays in `tokens:` and applies over any theme, light and dark; whether pages sit in the look's centred measure or fill the screen is one key, for the app (`pageWidth`) or a page (`width`), with the header's content lined up to the page column, under any theme. A module publishing a theme holds it to the renderer's contract from its own tests with `UiReactConformance.CheckTheme`: every element styled, no layout rule the screens rely on overridden, every control's keyboard, focus and dismissal behaviour met.
- **Buttons that answer in place, with no double submits.** A `Ui.Action` sends a `POST`, `PUT`, `PATCH` or `DELETE` to a target built from the form (`/tasks/{id}`, the id leaving the body), draws a success as its `result:` tree (an empty 204 counts) and any failure — a refusal, a 401, no answer at all — as its `failure:` tree, then reloads every reader and listing over the path it wrote and the paths `onSuccess.refreshes` names — a `*` or `**` segment (`/api/projects/{id}/**`) covering a whole subtree — and moves the page where `onSuccess.navigate` says. A `DELETE` that would drop an input is refused before the app runs. A form or a row takes no second press while its first is pending, `concurrency: serial` runs presses one after another, and a listing's or a list node's row draws the answer of its action — a download link, a status — in place of its button. A row's inputs that cannot make a valid request are refused before the app runs.
- **Screens in the viewer's language.** List the languages once in `translations:` and `UiReact.App` serves each request in its negotiated language: every page title, label, model title and enumeration label is served translated, with plurals and numbers formatted in the browser by the language's rules and a heading over data composed from the values it names (`{ text, values }`). What the screens draw on their own — buttons, the pager, confirmations, validation messages — arrives translated into fourteen languages: list `Ui.polishTranslations`, `Ui.japaneseTranslations` and the rest beside your own catalogs, and reword any one with a `Ui.Translations` of your own without touching a text you wrote. Each language is one cached document with `Vary` naming exactly the headers read.

### Background jobs

- **Background jobs that survive a crash.** A `Queue.Worker` runs a handler for each message of a durable, typed queue kept in your own PostgreSQL or SQLite database: a message is checked against the queue's `messageType` where it is enqueued, held under a renewed lease while it runs, cancelled at its `timeout`, retried with backoff stored in the database so any worker picks it up, and handed to `onDead` and kept for `Queue.Requeue` when it cannot be processed. `QueueSql.Enqueue` inside a `Sql.Transaction` is a transactional outbox — the message commits or rolls back with your writes, and an enqueue outside such a transaction is refused before the app runs. Workers on several machines share one queue without waiting on each other, `groupBy` delivers one entity's messages in order, and an id enqueued twice within `retention` is stored once.
- **Duplicate deliveries change nothing.** `IdempotencySql.Once` records a key — a message's `delivery.messageId`, a request id — in the same transaction as the writes it guards, so a redelivered message or a retried request commits its effects once per key. A concurrent duplicate waits for the first and then skips or runs as it committed or rolled back, a key reused with a different `fingerprint` is refused rather than skipped, and a `Once` outside a transaction on its ledger's database is refused before the app runs.

### Durable execution

- **Crash recovery.** Durable runs record each step and decision; a restart resumes where the work stopped.
- **Durability that can't break silently.** Swallowed suspensions are detected, a replay reaching a different step is refused, and `now()` / `uuidv4()` inside a replayed region are refused before the app runs.
- **Waiting for days.** `Durable.Sleep` / `Durable.Await` hold no process, connection or timer; a delivery is checked against its type.
- **Timing that survives restarts.** Long backoffs park with their attempt count, deadlines are fixed on the first pass, and missed schedules are found due.
- **Exactly-once with the database.** With the journal on the business connection, journal writes commit in the same transaction, and each region logs which regime it got (`durable.zone.mode`).

### Coordination

- **Idempotency.** `Idempotency.Once` claims atomically, replays the stored result on repeats and releases on failure; a repeated workflow `runId` attaches to the existing run.
- **Distributed locks.** `Lease.Critical` acquires, runs and releases, expires on `ttl`, fails closed on an empty key and guards release by holder.
- **Messages to every running instance.** A `Broadcast.Publish` sends a small typed message, optionally under a topic such as `rooms.42`, to every `Broadcast.Subscription` live on the channel, which runs its `invoke` per message and is told by `onGap` when it may have missed some. `BroadcastPostgres.Channel` carries it across instances on one PostgreSQL database, delivering a publish made in a `Sql.Transaction` only when it commits.
- **Business events handled in the same transaction.** A library declares a `Domain.Event` and announces it with `Domain.Emit`, knowing nothing of who reacts; the application adds `Domain.Handler`s (an audit row, a welcome email enqueued on an outbox) that run inside the announcing call and its transaction, so a failing handler rolls everything back, and `telo check` follows the path from emit to handler.
- **Race-free key/value.** `putIfAbsent` / `compareAndSet` are atomic, and a lost race is `null`, not an exception.
- **Rate limiting.** `RateLimit.Guard` and `RateLimit.Budget` return `{ allowed, remaining, retryAfter }` over any cache store.

### Caching

- **Stale-while-revalidate.** `Cache.View` revalidates in the background with single-flight, or synchronously, and serves stale on error.
- **Degraded mode.** A cache falls back to another store and reports `cache.degraded` / `cache.recovered`.

### Scheduling

- **Schedules.** `Schedule.Interval` and `Schedule.Cron` with a timezone and a per-tick `when:`; a failing tick re-arms, ticks never overlap, and shutdown waits for the tick in flight.
- **Long polling.** `Watch.Wait` / `Watch.Publish` with capped timeouts.

### Messaging

- **Transactional email and SMS behind one contract.** `Mail.Transport` and `Sms.Transport` take one message shape and answer one result, so an application or library sends through whichever transport the deployment configures (`Mail.Smtp`, `MailResend.Transport`, `SmsTwilio.Transport`) and a failed send is reported as one of two kinds — refused, or unavailable and worth retrying. A phone number that is not E.164 and an email with no body are refused before anything is sent.
- **Capture transports for tests.** `Mail.Capture` / `Sms.Capture` record what was sent and `CaptureRead` hands it back, so a flow that mails a link or texts a code is tested end to end with nothing sent.

### Translation

- **The request language, chosen for you.** List your languages once in the Application's `translations:` and each request's language is negotiated from `Accept-Language` (by quality, `pl-PL` finding `pl`) and read as `request.lang`; `preferredLanguages` on `Http.Server` adds your own choice from a cookie, path prefix or query parameter. Responses that depend on the language carry `Content-Language` and `Vary`, problem details are worded in it, and a library's texts are translated by the application's catalogs — no per-handler negotiation code.
- **Translated texts.** `Telo.TextTranslations` holds one language's translations; catalogs layer in order, so a later one overrides an earlier one's text. `I18n.translate(text, lang, values)` formats a text in the language asked for — falling back from `pl-PL` to `pl` to the source, with numbers and plural cases by the language's CLDR rules and no ambient locale; a text translated twice in one catalog is refused before the app runs.
- **A library's own texts, by key.** A library declares its labels and messages once in a `Telo.KeyedTranslations` document — `keys:`, each with its source wording and the values it is formatted with — and names the sets a kind shows with `x-telo-text-keys`, so the kind's controller receives each key in every served language, a kind extending it included; an application translates them under `messages:` in a catalog of the library's own translation kind, where a misspelt key, a placeholder the key does not declare or a plural case the language lacks is refused before the app runs, and overriding a library's wording never rewrites a text you wrote yourself.

### Files and streams

- **Atomic writes.** `Fs.FileWrite` renames into place and `Blob.Put` replaces whole; an over-size write stores nothing.
- **Streams without buffering.** `Stream.Chunk`, `Stream.Tap` and lazy `Run.Iteration`; multipart bodies arrive as a stream, and `Multipart.ReadPart` streams one named file out of an upload while the rest of the body is never read.

### Testing

- **Tests run the real app.** `App.Instance` runs the application file itself, and tests are manifests run by the kernel you deploy. Each test hands the app it starts its own ports and storage — a durable directory under `needs:` — so two tests never share state, and what it hands over is held to the app's own declarations before anything runs: a misspelled input, a value the app refuses or a source that is not an app fails `telo check`.
- **Containers on demand.** Tests start their own containers — readiness-waited, loopback-only, always removed — unchanged locally, in CI or in a runner session.
- **Assert on what happened.** `Assert.Events` matches kernel events as a subsequence or counts them (`times: 0` for "never").
- **No store mocks.** In-memory stores and `:memory:` SQLite run the production code path.
- **Benchmarks in CI.** `Benchmark.Suite` fails the build on `p99` thresholds.
- **Interactive apps.** `Channel.SendLine` / `Channel.ReadUntil` drive one step by step, with bounded reads.

### Security

- **Password hashing.** `Crypto.PasswordHash` hashes with argon2id at OWASP parameters (or bcrypt, scrypt, PBKDF2), verifies hashes imported from other systems, and reports `rehash` on a successful login so weaker hashes upgrade as users sign in. Passwords and hashes are redacted from trace payloads; `Crypto.Compare` compares secrets in constant time.
- **JWTs with rotating keys.** `Jose.Sign` and `Jose.Verify` issue and check tokens; a `Jose.KeySet` over a `KvStore.Store` generates its keys, stores them encrypted, rotates them when `Jose.Rotate` runs on a `Scheduler.Cron` (replicas rotating at once make one new key) and keeps a replaced key verifying for `rotation.retireAfter`. `Jose.PublicKeys` serves the JWKS, `Jose.RemoteKeySet` verifies another issuer's tokens by URL or discovery, `algorithms:` is required so a token never picks its own, and a refused token returns its reason instead of failing.

- **API keys.** `ApiKey.Verifier` accepts keys you declare in the manifest as digests or keys issued, listed, rotated and revoked at run time through `ApiKey.Issue` / `List` / `Rotate` / `Revoke` over a SQL-backed store. A mistyped key is refused before any lookup, only a digest is kept, and a revocation takes effect on every replica at its next request.
- **Sessions with log-out-everywhere.** `Session.Sessions` keeps login sessions in a `KvStore.Store` with idle and absolute lifetimes, an optional remember-me lifetime and a cap per user; `Session.Rotate` replaces one when privileges change, `Session.End` logs out one device and `Session.EndAll` every device at once. The browser holds only a cookie that `Http.FromCookie` hands to `Session.Verifier`.
- **Login throttling.** `Protection.PasswordThrottle` wraps a password check with a budget per identifier, so repeated wrong passwords are answered as throttled without calling the check.

### Auth and untrusted input

- **OAuth.** `OAuthClient`: PKCE on, `iss` checked, single-use sign-ins, one refresh per grant at a time, tokens never logged.
- **Shell commands.** `Shell.Command` `args:` run with no shell; `env: {X: null}` unsets an inherited secret.
- **Untrusted content.** Allowlist HTML sanitizing, `Image.Fit` sizing before decoding and stripping metadata, `Blob.Key` refusing `../x`.

### AI

- **Resumable chat turns, stopped from any replica.** `AiChat.StartTurn` answers at once while the agent's reply is journaled; `AiChat.TurnEvents` replays it from any event on any replica and follows it live, and `AiChat.CancelTurn` stops it wherever it runs, aborting the model call or tool in flight. A turn whose process died or was shut down closes with an error rather than hanging, and a retried send under one idempotency key starts one turn. `AiChat.Api` serves all of it over HTTP as Server-Sent Events that resume from the last event seen, with uploads checked against what the model accepts. An upload belongs to the conversation that first sends it, so no other conversation can send, read or delete it; deleting a conversation makes its files unreadable at once, and uploads no message sent are removed after `attachments.pendingRetention` by a scheduled `AiChat.AttachmentExpiry`.
- **Human approval.** `Ai.Agent` `approval:` gates tool calls.
- **Bounded agents.** `maxSteps` caps model calls and `maxToolResultBytes` caps each tool result, with an explicit truncation marker.
- **Files fetched for the model on demand.** A conversation names a file by a URI of your own scheme (`upload:7f3a`); the operation's `resolver:` fetches it for the model once per URI per call, and the history you store keeps the reference, never the bytes.
- **Concurrent tool calls.** Run concurrently, results returned in call order.
- **One error set per provider family.** Every model provider — and every search, OCR, graph and MCP client — reports one closed set of codes, with `retryAfterSeconds`.
- **Vector dimensions.** Enforced at insert and query.

## For module authors

- **Your own layout.** A browser component written for the layout contract is drawn by `Ui.ComponentLayout` — the renderer does the fetching, paging, reloading, label lookups and moves, and the component draws the records; a module can also ship a layout kind of its own, checked against the collection with no change to `ui`.
- **Rules for your kinds.** State cross-field and referrer rules as data, checked before the app runs.
- **Templated definitions.** Checked like any manifest; an error in a forwarded value is reported on the consumer's line. A template turns a consumer's list or map into resources, routes, map entries and steps with `!for-each`, and chooses with `!if` / `!switch` from what the consumer wrote; it is checked with no consumer and again for each one before the app runs, and each generated resource keeps a stable name that does not shift when an entry is added.
- **Typed node trees.** A kind whose schema is a recursive node tree (`$ref` to a named shape) gets every expression in it typed and evaluated at every depth, a nested `x-telo-context` adding its names to the enclosing one; a condition's schema that can never hold for the value it names (`x-telo-match-for`) is refused before the app runs.
- **No bundler config.** The kernel bundles TypeScript controllers and `exports.browser:` entries; `telo publish` uses the same builder.
- **Native controllers.** Rust controllers build on load, the kernels that can host a kind are derived from its `controllers:`, and `native:` files are declared once.
- **Runtime requirements.** `requires: telo:` gives a consumer on an older runtime one clear "runtime too old" error instead of errors blamed on their manifest, and ranges are verified at their edges on publish.
- **Publishing.** `telo publish` pushes an OCI artifact at `metadata.version`; an unpinned import or changed contents at a published version are refused.
- **Releases.** `telo release` decides bumps from payload digests, propagates them with reasons, writes every version file and `Cargo.lock`, and `telo release add` writes changelog fragments.
- **Diagnostics tests.** `Assert.Manifest` asserts the exact diagnostics a manifest produces, and can run it to prove both verdicts agree.
- **Test selection.** `telo changed` lists the tests a diff reaches.
- **Reproducible artifacts.** Layer archives are a pure function of their files; the module's `LICENSE` and upstream notices ship automatically.
