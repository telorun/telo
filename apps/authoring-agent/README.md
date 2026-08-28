# authoring-agent

The AI manifest-authoring agent: an HTTP/SSE application that edits a directory
of Telo manifests on a user's behalf. Studio's chat panel drives it, and it is
itself a Telo Application — the model, the tools, the conversation store and the
rate limits are all declared resources, not code.

The root manifest is a thin transport over `chat/`, a `Telo.Library` that owns
the whole chat backend: an OpenAI-backed `Ai.AgentStream`, the filesystem and
shell tools, the SQLite conversation store, the turn journal, and the handler
that ties them together. The split exists so the library's own tests drive the
same handler the HTTP routes do.

## The workspace

**Everything the agent reads or writes is rooted at `WORKSPACE_DIR`.** Every
filesystem tool and every spawned command resolves against it, so the agent
cannot reach the rest of the container by editing a path. It defaults to
`./workspace`.

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
them. What it still has to ask is the part nothing can discover: the identifier
and which env var holds the credential.

**A missing credential is not the end of it.** The agent drives OAuth consent
itself rather than reporting that it has none: it prints a verification URL and a
code, you approve on your own machine, and it polls. It uses the **device flow**
because it runs in a container your browser cannot reach, so a redirect has
nowhere to land. That happens across two runs — a poll cannot outlast the run
timeout while a human signs in — so the first prints the link, the turn ends
there, and the next run polls and does the reading in one go, since an in-memory
grant does not survive the process that obtained it. The one thing it cannot do
for you is register the application: you create the OAuth client and give it the
env var names for the id and secret.

**Probes read; they never write.** That is a rule in the prompt, and the prompt
is not an enforcement mechanism — the agent authors the probe, so nothing in the
tool prevents one that mutates. **The real control is the credential's own
scope.** Hand it a read-only token (`spreadsheets.readonly`) and the boundary
holds regardless of what the model writes. A failed probe is reported and turned
back into a question, never quietly replaced with a guess.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /chat` | Start a turn. `200 {turnId}`; `409 {activeTurnId}` when one is already running for the conversation; `429 {retryAfter}` at the operator's spend ceiling |
| `GET /chat/{turnId}/events` | The turn's stream, as `{ id, data }` SSE frames. Replays from `?lastEventId=` and then tails live, so a reload re-attaches to a turn in flight |
| `GET /workspace` | Content-hash tree, for diffing against the client's own files |
| `POST /workspace` | Apply an explicit write/delete change set |
| `GET /workspace/file?path=` | One file's contents |
| `GET /conversations/{id}` | The persisted message rows — the model's own view of the thread |
| `POST /conversations/{id}/messages` | Seed those rows into a fresh instance, idempotent by row id |

One turn at a time per conversation: the 409 is what stops two model turns
writing the same workspace at once. There is deliberately no single-file write
route — a change set of one is the same thing without a second set of
concurrency rules.

The conversation store is per container. A client that expects a thread to
outlive one instance keeps the rows itself and posts them back before the next
turn; that is what `POST /conversations/{id}/messages` is for, and it is how the
editor survives an agent being replaced mid-conversation.

There is **no abort route**. Studio asks for one and treats a 404 as "this agent
predates it", so a stopped turn runs to its natural end server-side.

## Configuration

Secrets:

| Env var | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required. The model credential |

Variables:

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `WORKSPACE_DIR` | `./workspace` | The directory every tool is rooted at (see above) |
| `BUDGET_LIMIT` | `4000000` | Total tokens across all turns per window — the operator's spend cap. Exhausted, `POST /chat` answers 429 |
| `ALLOW_MANIFEST_RUNS` | `false` | Lets the agent execute manifests — its tests, and probes against your live systems. Arbitrary code execution in this container, with its credentials — read the section above before turning it on |

The library takes several more that the root does not surface as env
(`model`, `dbFile`, the budget window, the per-IP throttle, and the two `telo`
CLI settings below); change them at the import in `telo.yaml`.

## What the agent is allowed to do

The tools are the security boundary, and they are declared:

- **File tools** (`write_file`, `edit_file`, `read_file`, `list_dir`,
  `delete_file`) are rooted at `WORKSPACE_DIR`.
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
against the live hub and imports the standard library at pinned published
versions, so it also fails while a change has landed here but is not yet
released and re-pinned. Cases skip themselves when `OPENAI_API_KEY` is unset.

`authors-manifest.yaml` and `asks-before-building.yaml` are a pair, and the pair
is the assertion: a fully specified request writes a valid file in the first
turn, a vague one writes nothing and comes back with questions. Either case
passing alone would be satisfied by an agent that always does one of the two.

`asks-about-external-data.yaml` covers the case that reads as a specification
and is not — a report joining YouTrack to a Google Sheet names three systems and
still says nothing about which sheet, which columns, or how the sides match.

`builds-with-tests.yaml` asserts the SHAPE of a build — a feature library, a
suite, a test beside it, the agent running that suite, and the suite passing when
this test runs it independently. `run-manifest-tool.yaml` and `telo-cli-tool.yaml`
need no model or key: they assert the two execution gates directly.

```bash
pnpm run telo apps/authoring-agent/test-suite-e2e.yaml
```
