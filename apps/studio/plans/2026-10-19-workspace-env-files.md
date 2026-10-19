# Studio runs read the workspace's env files

## Goal

Studio supplies an application's variables, secrets and ports from the same `.env` files `telo run` reads, bounded by the same `telo-workspace.yaml`. The workspace marker also declares which env files are sensitive, so every tool that writes, syncs or warns about env files gets the same answer.

**Before:**
- Studio keeps its own "Local" environment per application. It is stored only in the browser's local storage, under `telo-studio:deployments:v1`, with secrets in plain text.
- That map is the session `env` of every run. The missing-variable check and the port mappings read only that map.
- A value in a `.env` file never reaches a Studio run.
- `.env.local` is sensitive only by convention. `telo env template` hard-codes it as the file secrets go to.

**After:**
- A Studio run reads the env files visible from the manifest, using the walk `telo run` uses: up to the marker or the nearest `env.roots` match, collecting the files `env.files` names, nearer directory winning and later file winning within a directory.
- Those files are the application's environment in Studio. The Variables view is a view over those files and edits them.
- `env.files` entries can be marked sensitive. Writers, the cloud working copy, agent sync and the run warnings all read that mark.

## The `env.files` entry

An entry is a filename or `{ name, sensitive }`, the string-or-object form `release.modules` already uses:

```yaml
env:
  files: [.env, { name: .env.local, sensitive: true }]
```

- `name` follows today's filename rules: a `/` or a glob is an error.
- `sensitive` is a boolean. An unknown key in the object form is `WORKSPACE_UNKNOWN_KEY`, and a wrong type is `WORKSPACE_INVALID_VALUE`, both inside `env:`, so `telo run` refuses on them as it refuses on any `env:` error.
- With no `files:` declared, the default is `.env` and `.env.local`, with `.env.local` sensitive. Nothing changes for an existing workspace.
- With `files:` declared, only entries marked `sensitive: true` are sensitive. No filename is special.
- Sensitive means the file holds values that must not be committed or synced. It has nothing to do with log redaction, which stays keyed on declared `secrets:`.
- The editor offers `name` / `sensitive` inside an entry's object form, and reports the errors above at the entry.

An older CLI reading the object form refuses the run (`WORKSPACE_INVALID_VALUE` inside `env:`). The marker has no `requires:` to explain that, so the workspace guide states which telo release first reads the object form.

## One reader for the CLI and Studio

The analyzer gains the env-file resolution as a browser-safe function, given a way to read a file and list a directory:
- finding the marker;
- reading `env:`;
- the walk;
- the precedence;
- a `.env` parser.

It returns the merged values, the files that contributed, and which file each value came from. It also returns:
- each sensitive file seen;
- files that exist but could not be read;
- the marker's diagnostics, with an `env:` error marked as fatal.

The parser replaces the `dotenv` package in the CLI, which pulls in Node built-ins and cannot run in a browser. It must read every file exactly as `dotenv` 17 does. A conformance test runs a corpus through both. `dotenv` stays only as the analyzer's test dependency. The spelling `telo env template` uses to write a value moves beside the parser, so Studio writes values exactly as the template does.

`telo run`, a packaged application and `telo env template` read env files through this reader. Their behaviour is unchanged, apart from the sensitive-file rules below.

## Sensitive files, everywhere they matter

- **`telo env template`** writes secrets and sensitive need fields to the last sensitive entry of `env.files`, and everything else to the last non-sensitive one. If no entry of the needed kind exists, `--write` refuses, naming `env.files` and the entry to add or mark. The git-ignore warning covers every sensitive file it writes, not only `.env.local`.
- **`telo run`** prints a warning when a declared `secrets:` entry, or a need field marked sensitive, takes its value from a non-sensitive file: `[env] secret DB_PASSWORD is set in ./.env, which env.files does not mark sensitive — move it to a sensitive file`. The run proceeds.
- **The cloud working copy** never sends a file whose name is a sensitive entry, in any directory of the project.
- **Co-resident agent sync** never copies such a file into a session workspace.

## Studio

**Running**
- When a run starts, Studio resolves the env files for the application's manifest through the shared reader, over its workspace adapter, and sends the merged values as the session `env`.
- The walk cannot climb above the opened workspace folder. With no marker inside the folder, the walk stops at the folder.
- In Studio the files are the whole environment. On the local runner they override variables Studio's own process inherited, where `telo run` lets the shell win.
- The missing-variable check counts a value from a file as set. Port mappings read the resolved value, then the `default:`.
- A fatal `env:` error refuses the run, with the marker's message.
- An unreadable env file refuses the run, naming the file and the reason. Studio has no shell to fall back on, so a value it cannot read is a value the run lacks.
- A running watch session keeps the values it started with. An env file edit takes effect at the next start, as an edit to Studio's map does today.

**The Variables view**
- One row per declared variable, secret and port. Each row shows its value, the workspace-relative file it comes from, or that it is unset and whether that blocks a run. Secrets stay masked with a reveal toggle.
- Editing a value that comes from a file rewrites that one line in that file. Setting an unset value adds a line in the manifest's own directory: secrets and sensitive need fields go to the last sensitive entry of `env.files`, everything else to the last non-sensitive one. Clearing a value removes its line. Every other line of the file is left as it is.
- If a value needs a sensitive file and none is declared, the row says so, names `env.files`, and writes nothing.
- A secret whose value comes from a non-sensitive file carries the same warning `telo run` prints.
- The view re-reads the files when it opens and whenever a collected file is saved in Studio.
- The ad-hoc variables editor and the environment selector are removed. Undeclared variables live in the env files, which open in the code editor.

**Removed state**
- The per-application environment model and its store go.
- On first start, Studio deletes the `telo-studio:deployments:v1` key. Stored values are dropped, not migrated.

**Desktop file access**
- Tauri's file-system scope refuses paths with a leading dot on Linux and macOS, so `.env` shows in the explorer but cannot be opened.
- The read and write scopes gain `$HOME/**/.env` and `$HOME/**/.env.*`. Their literal leading dot is matched under the default rule, so other dotfiles (`~/.ssh`, `~/.aws`, and `.envrc`, which direnv executes) stay out of reach.
- On the desktop build, an `env.files` entry that is a dot-file named neither `.env` nor `.env.<suffix>` is reported as unreadable, naming the file and the scope. The browser build has no such limit.
- `.env` and `.env.local` open with `ini` highlighting.

## Documentation

- `docs/guides/workspaces.md`: the entry's object form, the sensitive default, what reads the mark, the release that first reads it.
- `docs/guides/what-you-get.md`, under security:
  - a secret set in a committed env file is warned at run and in Studio;
  - sensitive env files are never synced to Telo Cloud or into a session.
- The authoring agent primer: secrets go to the sensitive env files (`.env.local` by default), and Studio runs read the same files.
- `cli/nodejs/CLAUDE.md`, `apps/studio/CLAUDE.md` and the release guide's marker section.

## Release

One changeset naming `@telorun/analyzer`, `@telorun/cli` and `@telorun/ide-support` (the marker's editor diagnostics and completion). Studio is private and needs none.

## Verify

1. A workspace with no `env.files`: `telo run` loads exactly the values it loads today, and the CLI's existing env-file and `telo env template` tests pass unchanged on the shared parser.
2. The parser conformance test agrees with `dotenv` on every corpus file: quoting, escapes, multi-line values, comments, `export` prefixes, blank values.
3. `env: { files: [.env, { name: .secrets, sensitive: true }] }`: `telo env template --write` puts secrets into `.secrets`. With no sensitive entry, it refuses naming `env.files`. `{ name: .env.local, sensitve: true }` makes `telo run` refuse with `WORKSPACE_UNKNOWN_KEY`.
4. A secret set in `.env`: `telo run` prints the `[env]` warning and starts. Moving it to `.env.local` silences it.
5. In Studio, an app whose required secret is set only in `.env.local` one directory above the manifest starts. The Variables view shows the value as coming from that file. A port set in `.env` is the port the runner opens.
6. Editing a variable in the Variables view changes only its line in the file shown. Setting an unset secret adds it to `.env.local` beside the manifest.
7. A marker with a broken `env:` block refuses a Studio run with the marker's message. A `chmod 000 .env` refuses it naming the file.
8. Desktop build on Linux: `.env` opens, saves and is read by a run. A file under `~/.ssh` is still refused.
9. A cloud project with `.env.local` beside its manifest: the working copy's changes do not include it. A co-resident agent's workspace does not contain it.
10. After upgrading Studio, `telo-studio:deployments:v1` is gone from local storage, and the Variables view shows only file values.
