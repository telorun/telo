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

```bash
pnpm run telo apps/authoring-agent/test-suite-e2e.yaml
```
