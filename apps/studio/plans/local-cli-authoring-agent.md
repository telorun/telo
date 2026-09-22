# Authoring agent on the local CLI runner

## Goal

The desktop editor gets the authoring agent on the local CLI runner the way it does on k8s: co-resident in a watch session, writing the session's own workspace, and launchable on its own when no session is running.

**Before:** `telo runner` has no app catalog. It advertises no `apps` and no `features.agents`, and refuses a catalog session with `this runner has no application catalog`. The agent panel on the local CLI runner works only through the manual override URL.

**After:** Studio starts `telo runner` with a one-entry catalog, `authoring-agent`, whose manifest is shipped inside Studio. A Run in watch mode carries the agent beside the application. Opening the panel with no session running launches it on its own.

## Catalog entries are the runner's own vocabulary

`RUNNER_APPS` keeps one JSON shape per runner. The contract-level part of an entry is `title`, `description` and `port`, and only those are advertised or read by core. Everything else is validated by the runner that reads it, the same way session config already is:

- The docker and k8s runners validate `image` / `pullPolicy` / `env` exactly as today. An existing operator catalog keeps working unchanged, and a missing `image` is still refused at boot.
- `telo runner` validates `manifest` (an absolute path to a `telo.yaml`) and `env`. An entry carrying `image` is refused at boot, naming the entry, because this runner runs manifests rather than images.

`port`, when declared, is added to the entry's descriptor in `/v1/capabilities` `apps[]`. It is not a secret, and a client launching the app on its own needs it. The editor's standalone launch declares and waits on that port, and falls back to `8080` only when a runner advertises none.

## How `telo runner` runs a catalog entry

- **Staging.** Studio's resource directory is read-only on an installed build (Program Files, a signed `.app`), and the agent writes a SQLite file and a `.telo` cache beside its manifest. So each catalog process runs from a private copy of the entry's manifest directory, placed in the session's state directory next to its workspace. It gets the same `0700` treatment, and is reclaimed with the session.
- **Module cache.** Every catalog process of one runner shares one `TELO_CACHE_DIR` under the runner's state root, so the agent's imports are fetched once per runner rather than once per session.
- **Co-resident.** In a watch session that requests `agent`, the entry runs as one more `telo run` process of the running executable, with the entry's `env`, plus `WORKSPACE_DIR` set to the session workspace (as k8s does) and `CLICOLOR_FORCE=1`. Its `running` status carries the `agent` endpoint at the entry's `port`. Stopping the session stops it with the same process-group discipline the apps get.
- **Standalone** (`POST /v1/apps/authoring-agent/sessions`). The entry runs on its own with its default workspace inside its private copy.
- **Credential boundary.** The runner removes `RUNNER_APPS` from the environment every workload inherits, apps and agent alike. An entry's `env` reaches that entry's process and nothing else, so `OPENAI_API_KEY` never reaches a user's application.

## What the agent needs to run locally

The agent manifest gains three variables, each defaulting to today's behaviour so the published image is unchanged:

- `HOST`: the `Http.Server` bind address. Default `0.0.0.0`. Studio sets `127.0.0.1`, because an agent that writes files, and may run manifests, must not listen on the LAN.
- `CORS_ORIGINS`: JSON array of allowed origins. Unset keeps `*`. Studio sets its webview origins (the same list it passes to `--allow-origin`, plus the dev server origin in a development build), so a page the user visits cannot drive the agent from their browser.
- `TELO_PROGRAM`: JSON array forwarded to the chat library's `teloProgram`. Default `["telo"]`. Studio sets the exact executable the runner runs (the bundled sidecar, the user's override, or `node` plus this checkout's CLI in a development build), so the agent's `telo check` is the same `telo` as the runner's and never a `PATH` lookup.

The agent takes a `telo release` fragment for this change.

## Studio

- **Shipping the manifest.** A staging step, beside the CLI sidecar's, copies `apps/authoring-agent` (its `telo.yaml` and `chat/`, never `workspace/`, `tmp/` or `.telo/`) into the Tauri bundle's resources. A development build uses this checkout's `apps/authoring-agent` directly, just as it uses the checkout's CLI.
- **Building the catalog.** The Rust shell builds the `RUNNER_APPS` entry when it starts `telo runner` and passes it in the child's environment, never on argv:
  - `manifest`: the resolved agent manifest.
  - `port`: a free loopback port picked with the runner's own port.
  - `env`: `PORT`, `HOST`, `CORS_ORIGINS`, `TELO_PROGRAM`, `ALLOW_MANIFEST_RUNS` and `OPENAI_API_KEY`.
- **No key, no agent.** The key comes from the OS credential store, falling back to `OPENAI_API_KEY` in Studio's own environment. With neither, no entry is written and the runner advertises no agent.
- **Settings.** The local CLI runner's settings gain two things:
  - *Let the agent run manifests on this machine*, a toggle stored in the adapter config, off by default. Its description says it runs agent-written manifests with the user's own access and credentials. It maps to `ALLOW_MANIFEST_RUNS`.
  - *OpenAI API key*, a write-only secret field. It is saved to and cleared from the OS credential store through the Rust shell, and never read back into the webview. The row shows only whether a key is set.

  The settings row stays adapter-agnostic: an adapter declares its secret fields (id, title, description) and the row renders them the way it renders the config schema.
- **When changes apply.** The catalog is fixed when the runner starts, so a change to either setting applies on the next runner start. The row says so while a runner is up, beside the existing Stop. Nothing restarts silently, because that would kill live sessions.

## Documentation and release

- `packages/runner-core/CLAUDE.md` and `cli/nodejs/CLAUDE.md` § `telo runner`: catalog entries as runner vocabulary, the local catalog, staging, and the `RUNNER_APPS` scrub.
- `apps/studio/CLAUDE.md` § Agent: where the local agent comes from.
- The agent's README: the three new variables.
- Changesets: `@telorun/runner-core`, `@telorun/cli`, `@telorun/docker-runner`, `@telorun/k8s-runner`, `@telorun/studio`.

## Verify

1. **Contract.** A `RUNNER_APPS` entry with `image` still starts a docker session unchanged. The same entry given to `telo runner` is refused at boot, naming the entry. An entry with `manifest` and `port` appears in `/v1/capabilities` with its `port`, and under `features.agents`.
2. **Credential boundary.** A test asserts that a watch app in a session with an agent sees neither `RUNNER_APPS` nor the entry's `env`, and that the agent sees its entry's `env` and `WORKSPACE_DIR`.
3. **Co-resident, by execution.** In Studio with a key set, Run a manifest in watch mode. The panel talks to the agent without the override URL. A file the agent writes appears in the editor and triggers a reload. `netstat` shows the agent listening on `127.0.0.1` only.
4. **Standalone.** With no session running, opening the panel launches the agent and the launch waits on the advertised port, not `8080`.
5. **Manifest runs.** With the toggle off, `run_manifest` is refused. Toggle it on, stop the runner, run again, and the same request runs.
6. **No key.** With no key stored and no `OPENAI_API_KEY`, the panel shows no agent and the settings row says a key is needed.
7. **Installed build.** On a packaged Windows build, installed under Program Files, the agent starts. This proves the private copy, not the read-only resource directory, is what gets written.
8. **Image unchanged.** The published agent image, with none of the new variables set, binds `0.0.0.0` with CORS `*` and runs `telo` as before.
