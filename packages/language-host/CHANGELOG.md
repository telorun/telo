# @telorun/language-host

## 0.4.0

### Minor Changes

- 769b40d: A diagnostic that holds in some configurations of an application now carries `data.configurations` (and `telo check -o json` `configurations`) as partial assignments: one entry per block of the irredundant cover its message label is read off, each naming only the dimensions it narrows, so a finding in one flag's configurations no longer lists every assignment of the others. A dimension an entry leaves out holds every value; the finding holds in a configuration when some entry agrees with it on every key it names. The entries denote the same configurations as before, and the label is unchanged. The editor protocol generation is now 2 (`TELO_EDITOR_PROTOCOL`, `teloEditorProtocol`), because a host reading entries as complete assignments would misread them; a host speaks both generations, since a complete assignment reads correctly as a partial one, so every published engine is still offered. An application input's `requiredWhen` is evaluated the same way at the running configuration, and a reported dimension of a member carries its `member` (`telo module manifest --json`, `telo needs report`).

### Patch Changes

- Updated dependencies [769b40d]
- Updated dependencies [769b40d]
  - @telorun/editor-protocol@0.3.0

## 0.3.0

### Minor Changes

- b9e6234: The router carries structured editing across engines. `telo/viewModel` and `telo/celCompletion` go only to the engine serving the request's `owner`, and are answered `null` / `[]` without asking any engine when that engine does not advertise `experimental.telo.viewModel` or no running engine serves the owner — they are never sent to every engine. `telo/viewModelChanged` reaches the editor with its `owner` in canonical form and only from the owner's serving engine; revisions form one increasing sequence per owner across engines (a `telo/viewModel` answer's `revision` included), and the router sends a `telo/viewModelChanged` of its own whenever the engine serving an owner changes or goes, so a host reads the model again; an owner whose documents are all closed is forgotten, and one met again continues above every revision already shown. `LanguageRouter.supportsViewModel(owner)` tells an engine that predates structured editing (`false`) from one not running yet (`undefined`), and `canonicalUri` is exported so a host keys owners as the router does.

### Patch Changes

- Updated dependencies [b9e6234]
  - @telorun/editor-protocol@0.2.0

## 0.2.1

### Patch Changes

- Updated dependencies [587220a]
  - @telorun/editor-protocol@0.1.1

## 0.2.0

### Minor Changes

- 3fe9d3d: **The telo version a module is edited against is the version it runs on.** A session request may name, per application, the telo release it runs on (`telo` on each entry of `apps`, or on the request for a single-app session), and a runner advertising `features.teloVersions` runs exactly that version — never a substitute. What can be known without fetching anything is refused before a session exists: `400 telo_version_unavailable` carries `{ app, version, reason }`; a version sent to a runner that does not advertise the feature is `400 telo_version_unsupported`; text that is not a release version, or a session where only some apps name one, is `400 invalid_telo_version`. Fetching the version — an image pull, a release download — happens inside the session's start, with progress on its stream, and a fetch that fails is that session's failed start carrying the reason.

  - **docker-runner and k8s-runner** run that application's container on `<RUNNER_TELO_IMAGE_REPOSITORY>:<version>-<RUNNER_TELO_IMAGE_VARIANT>` (default `telorun/node:<version>-slim`; chart `session.teloImages`). Which versions may run is the image source's own rule on both; the k8s base-image catalog is the menu `config.image` is picked from and gates nothing else. An unreleased build identity (`X+unreleased`) has no published image: it runs on `RUNNER_TELO_UNRELEASED_IMAGE` where the operator set one and is refused, naming that variable, otherwise. The runner's own `workspace` container never follows an application's version — it stays on the operator's kernel image (`RUNNER_IMAGE`, new on docker-runner). `config.image` and `config.pullPolicy` are **deprecated**: a client naming no version still sends them and gets the old behaviour, the advertised schema marks both `deprecated: true` and requires neither, and a request naming a version beside either is `400 invalid_config`. How a version's image is pulled is the operator's — `RUNNER_PULL_POLICY` (`missing` | `always` | `never`, default `missing`; chart `session.teloImages.pullPolicy`), which also governs the runner's own workspace container. A failed start's status now carries the daemon's own message beside the stage.
  - **`telo runner`** runs its own version as itself and any other as that release's standalone binary for the platform — downloaded while the session starts, verified against the release's `checksums.txt`, cached per version. A cached binary is rehashed against the digest recorded when it was written, which detects a damaged file (the digest sits beside it, so this is not tamper protection). Another build's unreleased identity is refused up front; a failed download names its cause: no release or no binary for the platform, the HTTP status, a missing or non-matching checksum, no writable cache directory.
  - **The runtime says which version it is.** `Kernel.Starting` carries `{ telo }` (`X`, or `X+unreleased` for a build made while `X` is pending; the kernel's own generated `TELO_RUNTIME_VERSION`), and the runner passes it on as `telo` on that generation's `run` `started` event. The runner compares nothing.
  - **Studio** sends the version the language session reports for the module being run (`LanguageRouter.statusOf(uri)`, new in `@telorun/language-host`), shows a runner's refusal in the run dock with the runner's own reason, shows each application's reported version beside its generation, and warns — without stopping the run — when the runtime reports a different version than was asked for, or when the module has moved to another version since the run started. A module with no engine cannot be run until its version is resolved. The runner settings form leaves out every property its schema marks `deprecated`.

  `RunnerBackend` gains the optional `supplyTelo(version, config)`, `BackendAppSpec` carries `telo`, and `ServerDeps.validateConfig` is now a `ConfigGate`, told whether the request names a version.

  **The telo version picker no longer says whether a version's engine is cached** (`describeVersionMark` in `@telorun/language-host`, so in Studio and the VS Code extension alike): it changes nothing a reader would choose by, and "cached" is not a word every reader of that menu knows.

  **An engine built before its release is shown as `X (local)`**, where it read `X (unreleased build)` — in the status label, the version picker and every sentence built from them (`describeEngineVersion`).

  `@telorun/language-host` gains `describeAcceptance(mark)` and an `acceptance: false` option on `describeVersionMark`, for a host that marks acceptance with an icon rather than in the row's text, as Studio's menu now does.

  **Also in this change, and not version alignment:**

  - **A run's files sit in the session where the editor holds them, relative to the workspace root** (Studio's run bundle). An application at `<root>/apps/todo/telo.yaml` is now `apps/todo/telo.yaml` in the session workspace — `entryRelativePath` included — where a single-app run used to be rooted at the application's own directory. The agent's sync writes the editor's whole tree into the same volume relative to that root, and the two layouts disagreeing deleted a running app's files on the first agent turn. A relative path an app takes from an env value now resolves against the workspace root rather than the app's directory; `!module-path` is unaffected.
  - **Deleting an application in Studio stops its running session and drops its runs**, and a save ends the session of an application that has vanished some other way, instead of failing every save with `Entry module not found`.
  - **docker-runner's watch session passes telo's options before the manifest path.** They came after it, where every token is the application's, so an application declaring no arguments refused `--watch`, `--inspect` and `--no-open` at load.
  - **Replacing a docker watch session's app set pulls the new images before removing the running containers**, so a pull that fails leaves the session as it was.
  - **Studio's agent panel opens as a draft when no agent is reachable**, creating the conversation on the agent a send then launches — the first send no longer fails with `ERR_CONVERSATION_NOT_FOUND` — and draws no summary card for a turn that changed no file, ran nothing and was not reverted.
  - **Studio's telo version menu** lists the ten newest minor releases with each one's other versions nested, puts a row's description under its title, marks acceptance with an icon, and its label reads `Telo X` with `(auto)` when Auto chose the version.
  - The capability document gains `config.supersededByTelo` — the config properties a request leaves out once it names a version — and a release older than `MIN_SUPERVISABLE_TELO` (0.95.0, the oldest verified by execution) is refused before a session exists.

## 0.1.0

### Minor Changes

- eadb75a: Added: `@telorun/language-host`, the editor-side half of telo's language tooling. It reads the published `@telorun/language-server` versions from npm (only those speaking an editor protocol generation the host speaks, no prereleases or deprecated releases, plus the bundled engine), selects the telo version each module is edited against from its `requires: telo:` ranges or a pin (`selectVersion`), downloads an engine verified against its `sha512` integrity with its own `teloEditorProtocol` rechecked, and `LanguageRouter` presents one LSP endpoint across the engines in use — routing each document by `telo/requirements`, showing a file's diagnostics only from its owning engine, answering `telo/*` through host services, withdrawing a stopped engine's capability registrations, and reporting a status per active document including the offline-uncached, engine-refused, engine-failed, unoffered-pin and nothing-satisfies error states. URIs are compared in the protocol's canonical form. `initialize` never waits for the network: routing starts on the cached catalog, the registry is read in the background (bounded at 15 s), and a fresh catalog chooses again for every owner. The bundled engine's identity comes from its own handshake (`BundledEngine` is just `{ load() }`), every handshake is verified, and identities are ordered by semver precedence with the published engine winning a tie except when Auto keeps the bundled one. An engine that fails — reported by the spawner's `SpawnedEngine.onFailure`, or silent for 30 s at its handshake — has its pending requests rejected, its documents, registrations and diagnostics withdrawn, and is restarted by `retry()`. The router owns every editor registration: the union of the running engines' features (the semantic-token legend unioned by name and remapped), requests only to engines that advertised them, resolves back to their producer, one registration per distinct file watcher. An imported file shows the union of what running engines publish for it. `describeTeloStatus`, `describeVersionMark` and `describeAutoMark` word the status and the picker for every host. The router answers every `telo/*` request itself over three host seams — `HostFileSystem` (raw `stat` / `readText` / `readDirectory` by `file:` URI), `RemoteReader` (every non-`file:` read) and `HubClient` (the hub's version lists and ref search, parsed once for every host) — and keeps each workspace's Auto resolutions in a host `ResolutionStore`, so a module reopens on the engine it last resolved to. Browser-safe: web globals only.

### Patch Changes

- Updated dependencies [eadb75a]
  - @telorun/editor-protocol@0.1.0
