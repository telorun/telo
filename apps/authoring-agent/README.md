# authoring-agent

The AI manifest-authoring agent: an HTTP/SSE application that edits a directory
of Telo manifests on a user's behalf. Studio's chat panel drives it, and it is
itself a Telo Application — the model, the tools, the conversation store and the
rate limits are all declared resources, not code.

The root manifest is a thin transport over `chat/`, a `Telo.Library` that owns
the whole chat backend: an OpenAI-backed `Ai.AgentStream`, the filesystem and
shell tools, the turn journal and its projections in SQLite, and the handler
that ties them together. The split exists so the library's own tests drive the
same handler the HTTP routes do.

## The workspace

**Every path a tool call or a client names is rooted at `WORKSPACE_DIR`.**
Every filesystem tool and every spawned command resolves a relative path
against it, and every path the agent or a client supplies is judged before it
is used: one that is absolute, holds a backslash, starts with a drive letter or
has a `..` segment is refused with `ERR_PATH_OUTSIDE_WORKSPACE` — by
`write_file`, `edit_file`, `read_file`, `list_dir`, `delete_file`, `telo_check`
and `run_manifest`, for every argument of the `telo` tool, and by the
`/workspace` routes (400, nothing applied). The rule is lexical: it judges the
text of a path argument — not where a symbolic link inside the workspace
points, and not what a file the agent wrote goes on to reference: `telo check`
follows a manifest's `imports:` wherever they lead and quotes what it cannot
parse, and a manifest run under `ALLOW_MANIFEST_RUNS` reads anything the
container can. It confines what a tool call can NAME, not what the operating
system or the CLI then resolves. It defaults to `./workspace`.

There are two deployments, and they differ only in what that directory is.

**Standalone** — the agent owns a directory inside its own container. Nothing
else writes it, so the editor keeps its own files in step through the agent's
`/workspace` routes: it seeds the difference before a turn and reads back what
the agent wrote after one. The agent can check manifests but cannot observe an
application running, because there is none.

**Co-resident in a watch session** — the runner mounts the session's shared
workspace volume and points `WORKSPACE_DIR` at it. That directory is also where
each application container runs `telo run --watch`, so a file the agent writes
reloads the app: **the agent can change a manifest and see the consequence.**
The editor no longer talks to the agent about files at all — it reads and writes
the same volume through the runner's `/v1/sessions/:id/workspace` surface, which
is the write path its own saves already take. The agent's `/workspace` routes
stay for the standalone case.

Nothing in the image distinguishes the two. The agent is one writer on a
directory; whether anything else watches that directory is the runner's
arrangement, and setting `WORKSPACE_DIR` is the whole of it.

### The agent's own state

The agent keeps its state in `AGENT_STATE_DIR`, which defaults to `.telo-agent`
inside the workspace. Today that directory holds one file, `agent.sqlite`:

- **the turn journal** (`turn_journal`, `turn_journal_keys`) — every record of
  every turn, under the turn's id. It is the one source of truth: the event
  stream, the records route and the model's history are all read from it;
- **`turns`** — which turns belong to which conversation, in order, when each
  was started or last continued, and when a user aborted it. Metadata about
  journal keys: a turn's status is read from its key;
- **`messages` and `turn_projections`** — the model's history, projected from the
  journal (below). Disposable: dropped, they are rebuilt from the journal;
- **`turn_admissions`** — the records an `Idempotency-Key` replays from.

Nothing else is created there until a feature needs it.

It lives on the workspace volume because the container is the ephemeral part. A
co-resident agent's workspace is the session volume, which outlives the
container, so restarting the agent on the same `WORKSPACE_DIR` keeps its
conversations. `.telo-agent` is not workspace content: `GET /workspace`, the
per-turn `WORKSPACE STATE:` listing and the `list_dir` tool all leave it out,
Studio never syncs it in either direction, and the system prompt tells the agent
never to read, write or delete it.

## Asking before building

A request to build something new usually leaves decisions unmade — what the
thing exposes, where its data lives, whether it needs auth. The agent surfaces
those before it builds. A request that already answers everything material is
built immediately: asking is conditional on something being unsaid, so a
specified request never pays for a round-trip. Neither does an edit, a fix, or a
second request in a thread that already settled them.

**Questions come in rounds that narrow.** Round one settles the shape — what is
being built, how it runs, which systems it talks to — in at most four questions.
Each later round asks only what the previous answers made relevant, which is
where the specifics live: you cannot ask for a spreadsheet tab's column headers
until you know which tab, and asking for everything at once produces compound
questions ("provide: (1) the id, (2) the tab, (3) the headers, (4) the mapping")
that are unanswerable in a text box. Three rounds is the ceiling; past it the
agent builds with a stated assumption rather than asking again.

Each round writes no files and ends with one fenced block:

````
```telo-questions
{
  "questions": [
    {
      "id": "store",
      "question": "Where does the data live?",
      "options": [
        { "label": "SQLite file", "detail": "no server to run alongside", "recommended": true },
        { "label": "Postgres", "detail": "needs a database running" }
      ]
    }
  ]
}
```
````

A question may instead carry **no options at all** — an *open* question, answered
by typing:

```json
{ "id": "sheetColumns", "question": "What are the column headers of that sheet, in order?" }
```

That form exists because the failure it prevents is the expensive one. The agent
reads module fields from the hub and must never guess them; the same rule applies
to the user's own systems — a spreadsheet's columns, a tracker's field names, the
key two sources are joined on — except that no tool can answer, so it asks. A
made-up column name is not a syntax error: the manifest checks clean, runs, and
produces a wrong report, which nothing in the toolchain catches. Offering invented
options there would be worse than asking openly, since picking one makes the user
confirm a guess.

Exactly one option per question carries `recommended: true`, where there are
options at all. Studio renders the block as clickable options and sends the picks
back as an ordinary chat message,
so a client that does not parse it — or a user who turns the options off — reads
the same questions as text and answers them by typing. The agent is never told
which happened.

**Every question also takes an answer in the user's own words.** The options are
the agent's guesses at the useful answers, not the set of legal ones — a card
that accepted only them would make the agent's imagination the limit of what can
be built — so the prompt requires an answer from outside the list to be built as
written, never snapped to the nearest option offered.

It is a block in the reply text rather than a tool call because a tool result
feeds the model loop straight into another step: a tool cannot end a turn, and
ending the turn is what asking a question is for.

**The agent is told what is in the workspace, rather than looking it up.** Every
turn opens with a `WORKSPACE STATE:` message listing the workspace's paths (the
same exclusions the `list_dir` tool applies), or saying it is empty. It exists
because the agent asked "new application, or extend an existing one?" against an
empty workspace — a question the runtime can answer exactly and for free, and one
that reads as not having looked. A tool the model must remember to call is a tool
it sometimes will not; a message in the turn is not.

**It is told the time the same way.** Each turn also opens with a `CURRENT TIME:`
message in UTC, so "last week" and "since Friday" resolve to real dates instead
of guesses, and the agent reports the absolute range it resolved them to. It
rides the per-turn message rather than the system prompt because that prompt is a
literal fixed at load: a date stamped there would be the date the process
started, for as long as it runs. UTC because a report whose boundaries genuinely
depend on your timezone is a question worth asking, not an offset worth guessing.

**Thinking is visible.** The model resource asks for `reasoning.summary`, so each
turn streams a précis of its reasoning as `reasoning-delta` parts alongside the
answer, and Telo Studio shows them as a collapsible **Thinking** block. That
summary is all a client can ever show: the reasoning itself comes back encrypted,
is replayed through `providerState` so the chain survives the tool loop, and is
never readable. It is not persisted as the assistant's message either — the
conversation history keeps the answer, not the thinking.

## What it builds

An application is never one file. The agent splits the work into **feature
libraries** (one `Telo.Library` per domain area), writes **tests** against their
exports, and only then wires the application:

```
apps/todo/telo.yaml            # wiring only — imports, ports, targets
apps/todo/ordering/telo.yaml   # Telo.Library — one domain area
apps/todo/tests/telo.yaml      # Test.Suite over the files beside it
apps/todo/tests/*.yaml         # one test per behaviour
```

That split is what makes the behaviour testable at all: nothing can import a
`Telo.Application`, so anything written into `apps/<slug>/telo.yaml` is
reachable only by running the whole app. A test imports the feature library by
relative path — the same thing the app imports — so it exercises the real code
without standing up ports, servers or secrets.

The suite's `exclude` carries `telo.yaml` because discovery is a plain glob with
no notion of the file it was declared in: without it the suite runs itself.

**Outbound APIs are mocked, not called.** A test that needs a third-party service
stands an `Http.Server` up inside its own sequence — in `with:`, so it is torn
down and its port freed when the run ends; a module-level server would hold the
kernel open and the test would pass and then hang. The library under test is
pointed at it by setting its base-URL variable at the import, which is why that
URL and its credential are library variables from the start: a library with the
vendor's URL written into it cannot be tested at all.

## Running manifests

`run_manifest` executes one manifest — a test suite, a single test, or a
throwaway probe. It is **off by default** and `ALLOW_MANIFEST_RUNS` turns it on;
when off it refuses with `ERR_MANIFEST_RUNS_NOT_ALLOWED` and the agent falls back
to checking manifests and asking questions it might otherwise have answered
itself.

The default is the security boundary, not a preference, and the switch grants
strictly more than "run the tests". A manifest the agent wrote is arbitrary
code: it can declare a `Shell.Command`, read any file the container can, and
reach the network **with whatever credentials that container holds**.
`Shell.LocalHost.env` is an *overlay*, so a child inherits every operator
variable except the ones named — `OPENAI_API_KEY` is scrubbed, and whatever else
is set is not, because a module cannot enumerate it. There is no narrower
reading available: once a manifest can run, it can call your live third-party
systems. So turn it on only where the person prompting owns the container — a
per-session or co-resident agent in the user's own workspace, which is already
where their `telo run --watch` executes the same manifests — and never for an
agent open to anonymous callers.

Runs are bounded by a timeout (`runTimeoutMs`, 120s), because a test suite
terminates and an application does not, and pointing the runner at an app is an
easy mistake.

### Probes — discovering instead of asking

With runs enabled, the agent answers its own questions where it can. Given a
spreadsheet id and a token it writes a throwaway manifest under `.probes/`, runs
it, reads what it printed, and deletes it — so it learns the tabs, the column
headers and the real shape of the data rather than asking you to transcribe
them. What it still has to ask is the part nothing can discover: the identifier,
and which identity to authenticate as where several plausibly exist. It does not
ask what to CALL the environment variable — that name is one the manifest
declares, so it picks it and tells you which vars to set when it is done.

**A missing credential is not the end of it.** The agent drives OAuth consent
itself rather than reporting that it has none: it prints a verification URL and a
code, you approve on your own machine, and it polls. It uses the **device flow**
because it runs in a container your browser cannot reach, so a redirect has
nowhere to land. That happens across two runs — a poll cannot outlast the run
timeout while a human signs in — so the first prints the link, the turn ends
there, and the next run polls and does the reading in one go, since an in-memory
grant does not survive the process that obtained it. The one thing it cannot do
for you is register the application: you create the OAuth client and give it the
id and secret, which it reads from variables it names and reports back to you.

**Probes read; they never write.** That is a rule in the prompt, and the prompt
is not an enforcement mechanism — the agent authors the probe, so nothing in the
tool prevents one that mutates. **The real control is the credential's own
scope.** Hand it a read-only token (`spreadsheets.readonly`) and the boundary
holds regardless of what the model writes. A failed probe is reported and turned
back into a question, never quietly replaced with a guess.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /chat` | Start a turn. `200 {turnId}`, or a coded refusal (below). Takes an optional `Idempotency-Key` header |
| `GET /chat/{turnId}/events` | The turn's records as SSE frames, replayed and then tailed (below) |
| `POST /chat/{turnId}/abort` | Cancel the turn's running attempt. No body. `200 {cancelled}` (below) |
| `POST /chat/{turnId}/continue` | Continue an interrupted turn inside the same turn. No body. `200 {turnId, fromId}` (below) |
| `GET /conversations/{id}/records` | The conversation's turns and their records, paged (below) |
| `GET /workspace` | Content-hash tree, for diffing against the client's own files |
| `POST /workspace` | Apply an explicit write/delete change set |
| `GET /workspace/file?path=` | One file's contents |
| `GET /capabilities` | `{ agent: { name, version }, prompt: { id }, auth }` — who this agent is: the application's name and version, `prompt.id` the lowercase hex SHA-256 of `chat/primer.md` (the system prompt it runs with), `auth` `none` or `bearer` |
| `GET /health` | `200 { status: "up" }` — liveness. Unguarded |
| `GET /ready` | `200 { ready: true, reasons: [] }`, or `503 { ready: false, reasons: [{ code, message }] }` with `SCHEMA_UNAVAILABLE` (the conversation database cannot be read), `MODEL_CREDENTIAL_MISSING` (`OPENAI_API_KEY` is empty) or `WORKSPACE_NOT_WRITABLE` (writing and removing `.telo-agent/ready-probe` failed). Each message is fixed; the failure's own text goes to the log as a `warn` record. Unguarded |

Every route but `/health` and `/ready` passes one guard, before the request
body is read:

- **Origin.** A request whose `Origin` is not in `ALLOWED_ORIGINS` is refused
  `403 { error, code: "ERR_ORIGIN_NOT_ALLOWED" }` — CORS alone only stops a
  browser from reading the answer, not the request from running. A request
  with no `Origin` (a CLI, a server) goes on to the token check. `*` admits
  every origin except `null` (a sandboxed or file page), which must be listed.
  Narrowing it, list the Studio origins you use: `https://studio.telo.run` for
  the web editor, and the desktop app's `tauri://localhost` (macOS, Linux),
  `http://tauri.localhost` and `https://tauri.localhost` (Windows).
- **Token.** When `AGENT_TOKEN` is set, a request without
  `Authorization: Bearer <token>` (scheme case-insensitive) is refused
  `401 { error, code: "ERR_UNAUTHENTICATED" }` with `WWW-Authenticate: Bearer`.
  The comparison is of HMACs keyed by the token, so its timing reveals nothing
  about a guess. Unset, every route is open, and the agent says so once at boot
  in a `warn` record naming what is exposed.

CORS preflight is answered before the guard, so a browser can ask whether it
may send `Authorization` before it has a token.

Every non-200 answer from `POST /chat` is `{ error, code, … }`, and the `code`
is what a client branches on:

| Status | `code` | Meaning |
| --- | --- | --- |
| 429 | `ERR_RATE_LIMITED` | Too many turns from this client address. Carries `retryAfter` (seconds) |
| 429 | `ERR_AT_CAPACITY` | The operator's spend ceiling is reached. Carries `retryAfter` (seconds) |
| 409 | `ERR_TURN_IN_PROGRESS` | A turn is already running for the conversation. Carries `activeTurnId` |
| 409 | `ERR_IDEMPOTENCY_KEY_IN_FLIGHT` | A request with the same key is still being admitted; retry with the same key |
| 422 | `ERR_IDEMPOTENCY_KEY_REUSED` | The key was already used for a different message in this conversation |
| 500 | the failure's own code | Anything else |

A refused start leaves nothing behind: the throttle and the budget refuse
before anything is written, and a start refused because another turn is running
— or failing after its reservation, at the claim, the `turns` row or the lease —
takes back its reservation and whatever of its journal key and `turns` row it
wrote. A failure is answered with its own code.

**`Idempotency-Key`** (optional, 1–255 characters) makes a retried POST safe.
The admission runs at most once per `<conversationId>:<key>`: a repeat returns
the original `200 { turnId }` instead of starting a second turn. The same key
with a different message (compared by SHA-256) is `ERR_IDEMPOTENCY_KEY_REUSED`.
The record lives in `agent.sqlite` for 24 hours, so it survives a restart. A
refusal releases the key, so retrying after a 429 is a fresh attempt rather than
a replay of the refusal. Without the header nothing is deduplicated. Send one key
per message, and the same key on every retry of that message.

One turn at a time per conversation: `ERR_TURN_IN_PROGRESS` is what stops two
model turns writing the same workspace at once. That lock is held in memory.
There is deliberately no single-file write route — a change set of one is the
same thing without a second set of concurrency rules.

**`POST /chat/{turnId}/abort`** cancels the turn's running attempt through the
conversation's lease: the model call and the running tool see the cancellation
at once, so the workspace stops changing; the journal fails the key with
`ERR_INVOKE_CANCELLED`, which is the event stream's last frame; the reservation
is settled to what the completed model calls cost; and the conversation takes
its next `POST /chat` immediately. It answers `{ cancelled: true }`, or
`{ cancelled: false }` when nothing was running for the turn. An unknown turn is
404 `ERR_TURN_NOT_FOUND`, a removed one 410 `ERR_JOURNAL_KEY_REMOVED`. The
cancellation is process-local, like the lease: it reaches a turn this process
runs.

**`POST /chat/{turnId}/continue`** picks an interrupted turn back up — one that
failed, or whose process died — as another attempt at the **same** turn: same
id, same records, same event stream. The model is given the turn's recorded
history in full — every tool call and result the interrupted attempt recorded —
followed by a note naming what interrupted it and every tool call it started
with no recorded result ("effect unknown — check before repeating"), so it goes
on from where it stopped instead of starting over. It answers
`200 { turnId, fromId }`: `fromId` is the turn's last record before the new
attempt, whose `turn-continued` record comes next, so a client re-attaches to
the event stream from the last id it saw. Refusals, checked in this order:

| Status | `code` | Meaning |
| --- | --- | --- |
| 410 | `ERR_JOURNAL_KEY_REMOVED` | The turn was removed |
| 404 | `ERR_TURN_NOT_FOUND` | No such turn on this agent |
| 409 | `ERR_TURN_IN_PROGRESS` | A turn of the conversation is still running — this one (its stream was lost, not its work) or a later one. Carries `activeTurnId` |
| 409 | `ERR_TURN_NOT_CONTINUABLE` | Carries `reason`: `finished`, `aborted` (a user's abort is a chosen ending), or `superseded` (a later turn exists; only the last turn continues) |
| 429 | `ERR_RATE_LIMITED` / `ERR_AT_CAPACITY` | As for `POST /chat`, with `retryAfter` |

Each attempt reserves against the budget and settles on its own; a continue that
fails before its attempt starts refunds its reservation and answers with the
failure's own code. A continue
that finds the turn already taken over by another continue's attempt answers
409 `ERR_TURN_IN_PROGRESS` naming the turn itself.

### A turn's records

`POST /chat` claims the turn's journal key before it answers, so the turn exists
the moment its id does. The turn then records, in order:

| Record `type` | What it is |
| --- | --- |
| `user-message` | Always first: `{ content, model }` — what was asked, and the model answering it |
| `turn-continued` | Opens each attempt after the first: `{ note, model }` — what the model was told about the interruption, and the model answering |
| `text-delta`, `reasoning-delta` | The reply and the model's summary of its thinking, as they stream |
| `tool-call`, `tool-result` | A tool the model called, and what came back (`toolCall.id` = `toolResult.toolCallId`) |
| `provider-state` | The model's own replay material (encrypted reasoning); nothing to render |
| `step-finish` | The end of one model call, with its usage |
| `finish` | The end of the turn, with the usage of every call summed |

A turn that fails records no terminal record of its own: the journal marks the
key failed with the error's code, message and data, and every reader is told.
Its status is `running` while its key is open, `finished` once the key finished,
`failed` once the key failed — including a turn whose process died, which the
journal fails as `ERR_JOURNAL_WRITER_LOST` once its writer has been silent for 30
seconds — and `aborted` when a user's abort failed it with
`ERR_INVOKE_CANCELLED`. A shutdown cancels a turn the same way, and that turn
stays `failed`, so it can be continued.

**`GET /chat/{turnId}/events`** streams them as SSE frames: each record is a
`message` event whose `id:` line is the record's id and whose data is
`{ id, data }`. A running turn replays and then tails; a finished one replays and
ends; a failed one replays and ends with an `event: error` frame carrying
`{ code, message }` — and so does a turn removed while it is read
(`ERR_JOURNAL_KEY_REMOVED`). Resume after the last id seen with the
`Last-Event-ID` header (a browser's `EventSource` sends it by itself) or
`?lastEventId=`; the header wins, and a value that is not digits is 400. A turn
nobody started is 404 `ERR_TURN_NOT_FOUND`; a removed one is 410
`ERR_JOURNAL_KEY_REMOVED` for `RETENTION_DAYS` after its removal.

**`GET /conversations/{id}/records?fromTurn=&fromId=&limit=`** returns
`{ turns: [{ turnId, status, error, startedAt, records: [{ id, data }] }], next }`
— `limit` records per page (default 2000, at most 10000). Each turn's status and
error come from the same snapshot its page was planned from, so a turn that ends
while the page is read is reported `running` with the records up to that point,
and a client attaching to its event stream from the last of them receives the
rest. `next` is `{ fromTurn, fromId }` for the following page, or
null on the last. An unknown conversation is an empty page; a `fromTurn` that is
not one of its turns is 404 `ERR_TURN_NOT_FOUND`. The records of a turn are
exactly the frames its event stream delivers, so a client renders a conversation
it opens and a turn it follows with the same fold.

### The model's history

The model does not read the journal record by record: each turn is **projected**
into `messages` — the user's message, then per model call an assistant row (its
text and the tool calls that got a result) followed by the `tool` rows answering
them — and `turn_projections` records how far each turn was projected, the
provider state it ended with and the model that produced it. A turn is projected
when it ends, however it ends — after its reservation is settled, so a failed
projection still ends the turn with its error but never leaves the reservation
held — and before any history read every turn whose
journal holds records its projection has not seen is caught up. A tool call with
no recorded result is left out, since the provider refuses a call with no
answer. A `turn-continued` record closes the interrupted model call like the end
of a call does and adds its note as a user message, so a continued turn replays
every attempt in order. The last recorded provider state is replayed only to an
attempt running on the model that produced it. `rebuildProjection` (exported by
the chat library) projects a conversation again from its journal.

### Retention

Retention deletes **whole conversations**: one with no turn started or continued
for `RETENTION_DAYS` loses every turn's journal key, then its `messages`,
`turn_projections` and `turns` rows — nothing of a conversation outlives its
source. A removed turn's event stream answers 410 for another `RETENTION_DAYS`
(the journal's removal marker), then 404. The sweep runs at boot and hourly; it
is exported as `retentionSweep { idleBefore }`, and every step of it is safe to
repeat, so a sweep a crash cut short is finished by the next one.

Breaking against earlier releases: `GET /conversations/{id}` and
`POST /conversations/{id}/messages` are gone — the records route replaces the
first, and a client no longer seeds history, because the agent keeps it. The
old `messages` table held joined text only and is replaced; conversations from
before this release keep no history.

## Configuration

Secrets:

| Env var | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required. The model credential; any value when `MODEL_ENDPOINT` is a keyless endpoint |
| `AGENT_TOKEN` | Default empty. The bearer token every guarded route requires; empty leaves them open (one `warn` at boot says so). A runner that mints a per-session token injects it here — its catalog entry declares `"tokenEnv": "AGENT_TOKEN"` |

Variables:

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `WORKSPACE_DIR` | `./workspace` | The directory every tool is rooted at (see above) |
| `AGENT_STATE_DIR` | `<WORKSPACE_DIR>/.telo-agent` | Where the agent keeps its own state — `agent.sqlite` (see above) |
| `MODEL` | `gpt-5.2` | The model every turn runs on. Changing it drops the recorded reasoning on the next turn |
| `MODEL_ENDPOINT` | `https://api.openai.com/v1` | The OpenAI-compatible endpoint the model is called through — a gateway, or the local stub the tests use |
| `RETENTION_DAYS` | `30` | Days a conversation may sit idle before it is deleted whole, and how long its removed turns then answer 410 rather than 404 (at least 1) |
| `BUDGET_LIMIT` | `4000000` | Total tokens across all turns per window — the operator's spend cap. Exhausted, `POST /chat` answers 429 |
| `REASONING_EFFORT` | `medium` | How hard the model thinks before each turn: `minimal`, `low`, `medium` or `high`. Trades answer quality against latency and spend on every turn; `minimal` is the pre-reasoning behaviour |
| `ALLOW_MANIFEST_RUNS` | `false` | Lets the agent execute manifests — its tests, and probes against your live systems. Arbitrary code execution in this container, with its credentials — read the section above before turning it on |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins a browser may call the guarded routes from (see Routes) |
| `OTLP_ENDPOINT` | empty | An OpenTelemetry collector's base URL: traces go to `<url>/v1/traces` and log records to `<url>/v1/logs`. Empty, every finished span is written as a `debug` log record instead, which the default `info` level does not print |
| `TELO_PROGRAM` | `["telo"]` | How the agent invokes the `telo` CLI, as a JSON array — the program and any leading arguments — for its check loop and its `telo` tool alike |

The library takes several more that the root does not surface as env (the
budget window, the per-IP throttle, and the `telo` verb list below); change
them at the import in `telo.yaml`.

## Traces and what to count

With `OTLP_ENDPOINT` set the agent exports spans; there is no separate metrics
signal. **One turn is one trace**, rooted at the detached turn body (the span
carrying `telo.agent.turn.id` and `gen_ai.conversation.id`), with the agent run
(`invoke_agent author`), one `chat <model>` span per model call and one
`execute_tool <name>` span per tool call beneath it, in call order, and the
tool's own span under that. The span that settles a turn's budget carries
`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`, and every write,
edit and check span carries `telo.check.exit_code`. No span carries a prompt,
a message or a file's content. Every counter and histogram is an aggregation a
collector computes over those spans:

| Measure | Aggregation |
| --- | --- |
| Turns started | count of turn root spans (`telo.agent.turn.id` present, no parent) |
| Turns finished / aborted / failed | the same, grouped by `telo.span.outcome` (`ok`, `cancelled`, `failed` / `rejected`) |
| Tool calls by name × outcome | count of `execute_tool` spans grouped by `gen_ai.tool.name` and `telo.span.outcome` (`error.type` on a failure) |
| Check failures | count of spans with `telo.check.exit_code` ≠ 0 |
| Tokens by conversation | sum of `gen_ai.usage.input_tokens` + `gen_ai.usage.output_tokens`, grouped by the trace root's `gen_ai.conversation.id` |
| Turn duration | histogram of the turn root span's end − start |
| Steps per turn | histogram of `ai.agent.steps` on the `invoke_agent` span |

With `OTLP_ENDPOINT` empty the same spans are written as `debug` log records
(`event_name: telo.span`), which the default `info` level does not print.

## What the agent is allowed to do

The tools are the security boundary, and they are declared:

- **File tools** (`write_file`, `edit_file`, `read_file`, `list_dir`,
  `delete_file`) are rooted at `WORKSPACE_DIR`, and a path outside it is
  refused (see The workspace).
- **A write or edit whose resulting content holds a credential is refused**
  with `ERR_SECRET_IN_MANIFEST` before anything is written, naming each line
  and rule — `secret-scan`'s `credentialFindings`: provider key prefixes, PEM
  private keys and long high-entropy tokens, with integrity pins exempt. There
  is no override; the agent is told to declare a `secrets:` entry instead. The
  editor's own `POST /workspace` is not scanned.
- **Every tool result is text the model reads**: a write is `wrote <path>`
  then `check: clean` or one `file:line:col CODE message` line per
  diagnostic; a read is the file as it is; a listing is one path per line; a
  command is its output. The structured result still rides the recorded
  tool-result record as `output` for clients.
- **`telo check` runs automatically after every write and edit**, and its verdict
  comes back in the tool result — so the agent validates its own output rather
  than being asked to remember to.
- **The `telo` tool may only invoke a subcommand in `teloVerbs`**, which defaults
  to the verbs that merely inspect: `check`, `cel`, `module`, `search`. `run`,
  `publish`, `install` and `upgrade` are absent on purpose — `run` is arbitrary
  code execution on this host driven by an anonymous prompt, and `publish` would
  spend the operator's registry credentials. The check is on `argv[0]`, which
  also closes the CLI's default-command hole: `telo ./x.yaml` means `run`, and a
  bare path matches no verb, so it is rejected rather than silently executed.
- **Executing a manifest is `run_manifest`, a separate switch**
  (`ALLOW_MANIFEST_RUNS`, off by default) rather than a `run` entry in
  `teloVerbs`. Two different people make those two decisions: the verb list says
  which *inspection* commands are available, while this one turns code execution
  on. Folding `run` into the list would hide a security decision inside a list
  read as a convenience.
- **Every subprocess is execed without a shell and without the key** —
  `OPENAI_API_KEY` is unset in the child, so a tool call cannot read it back out.
- **Hub discovery** (`search_resources`, `get_module_manifest`) comes from an
  `AiMcp.ToolProvider` over the hub's MCP endpoint, so the agent looks modules up
  live instead of from a frozen list.

A deployment whose callers are trusted can widen `teloVerbs` at the import.

## Running it

```bash
OPENAI_API_KEY=sk-... pnpm run telo apps/authoring-agent/telo.yaml
```

The image is one self-contained artifact built on the Telo CLI image, with every
controller pre-fetched by `telo install` so boot does no network I/O:

```bash
docker build -t telorun/authoring-agent apps/authoring-agent
```

A runner offers it by naming it in `RUNNER_APPS` — as an app clients can launch
by name, as a session's co-resident agent, or both. The image and the operator
env stay server-side either way; a client only ever asks for it by name. See the
runner READMEs for the catalog entry, including the `port` a co-resident agent
must declare.

## Tests

`test-suite-e2e.yaml` is separate from the repo suite: it drives a real model
against the live hub, and imports the standard library at pinned published
versions once a release is out (by in-repo path while a change to it is being
built), so it also fails while a change has landed here but is not yet
released and re-pinned. Live cases skip themselves when `OPENAI_API_KEY` is
unset.

The offline cases run whole turns against `chat/tests/__fixtures__/provider-stub`,
a local stand-in for the responses endpoint reached through `MODEL_ENDPOINT`: it replies, calls one tool, refuses, or holds a reply until a test calls its `POST /release` (an aborted turn's request ends with the abort) depending on the message, and keeps every request it was sent for a test to read.

`authors-manifest.yaml` and `asks-before-building.yaml` are a pair, and the pair
is the assertion: a fully specified request writes a valid file in the first
turn, a vague one writes nothing and comes back with questions. Either case
passing alone would be satisfied by an agent that always does one of the two.

`asks-about-external-data.yaml` covers the case that reads as a specification
and is not — a report joining YouTrack to a Google Sheet names three systems and
still says nothing about which sheet, which columns, or how the sides match.

`boundary-auth.yaml`, `workspace-tools.yaml` and `turn-tracing.yaml` need no
model either. The first pins the guard — 401 on every guarded route without the
bearer, 403 for a foreign origin even with it, preflight, `/health`, `/ready`,
`/capabilities` and the boot warning, read from an in-test OTLP collector
(`chat/tests/__fixtures__/otlp-receiver`). The second scripts tool calls through
the stub (`STUB_CALLS:`) and asserts what the model reads back: every text
rendering, path confinement, secret refusal, and both `/workspace` routes. The
third runs one build turn against the collector and asserts its one trace, then
starts the agent with no endpoint and watches a span arrive as a log record.

`builds-with-tests.yaml` asserts the SHAPE of a build — a feature library, a
suite, a test beside it, the agent running that suite, and the suite passing when
this test runs it independently. `run-manifest-tool.yaml` and `telo-cli-tool.yaml`
need no model or key: they assert the two execution gates directly.

`agent-state-survives-restart.yaml`, `chat-start-idempotency.yaml` and
`journal-history.yaml` boot the application itself (`App.Instance`, the stub or a
dummy key, a workspace of their own under `chat/tests/.scratch/`) and need no
model: the first restarts the agent on the same workspace and reads the same
records page back; the second pins `Idempotency-Key` replay, key reuse, a key
still being admitted, and that a start refused for capacity or for a running
turn leaves nothing behind; the third drives the event stream and the records
route — a failed turn's error frame, 404, 410, paging, `Last-Event-ID` — and
that recorded reasoning reaches only the model that produced it.
`abort-continue.yaml` boots it the same way: aborting a running turn ends its
stream with `ERR_INVOKE_CANCELLED`, reads as `aborted` and frees the
conversation; a refused turn is continued inside the same turn with the note the
model then receives; and every refusal of both routes answers its code.
`reservation-settlement.yaml` boots it the same way and pins that a reservation is always given back or settled: an admission that fails after reserving answers with its own error, leaves its key removed and refunds; a turn whose projection fails at its ending is still settled; a continue that fails after reserving refunds.
`projection-rebuild.yaml` imports the chat library and rebuilds the projection
from the journal; `retention-sweep.yaml` imports it too and deletes an idle
conversation whole while an active one with old turns is untouched, including
after a sweep a crash cut short.

```bash
pnpm run telo apps/authoring-agent/test-suite-e2e.yaml
```
