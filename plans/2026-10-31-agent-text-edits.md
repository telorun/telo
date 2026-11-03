---
status: approved
priority: medium
depends-on: []
packages: [modules/ai, modules/text-diff, modules/fs, apps/authoring-agent]
---

# Raw-text edits and moves for the authoring agent

## Problem

The authoring agent changes files only through JSON tool calls, and that costs it in three ways.

- **Escaping.** A tool call's arguments are one JSON object (the Messages API's `tool_use.input`; `Ai.Agent` raises anything else). `write_file.content` and `edit_file.oldString` / `newString` are JSON strings, so the model escapes every newline, quote and backslash of a manifest. CEL is full of quotes and already doubly escaped (`'\\n'`), and a block scalar is indentation-sensitive. A slip makes `oldString` absent or non-unique, and the agent retries.
- **One edit per call.** `edit_file` replaces one substring and runs `telo check` after it. Three edits to one manifest are three leases, three checkpoint entries, three checks — and the first check reports the dangling references the third edit would have fixed. Every result is re-sent on every later step.
- **No move.** There is no move or rename of a file or folder. The agent reads, writes whole at the new path and deletes the old one; a folder is that per file. Relative imports and `!module-path` / `!include-*` claims in the copies keep their old paths, and a delete past the checkpoint bound (`ERR_CHECKPOINT_TOO_LARGE`) leaves the files duplicated.

Telo cannot make a tool call carry raw text: the `anthropic` module speaks the API's JSON tool input, and `Ai.Agent` hands a tool a parsed `arguments` object. But a model's reply TEXT has no escaping, and the application already reads structure out of reply text (the `telo-questions` block).

## Solution

**The model writes file content and edits as fenced blocks in its reply; `Ai.Agent` turns each block into the arguments of one of its own tools, runs it through the ordinary tool path, and answers with the results.** Four parts:

- `ai`: `Ai.Agent.textTools` — extracting blocks and dispatching them.
- `text-diff`: `TextDiff.applyPatch` — applying a SEARCH/REPLACE patch to a text, as a pure function beside `lineDiff`.
- `fs`: `Fs.Move` — a rename of a file or directory.
- The authoring agent: `edit_file` gains a `patch` form, `write_file` and `edit_file` are offered as blocks, and a `move_file` tool is added. Moves stay a JSON tool: a move carries two short paths and nothing to escape.

### The blocks

A block opens with a fence line at column 0 — three or more backticks, then a tag, then `name=value` attributes separated by spaces (a value holds no space and no quote) — and closes with a line of only backticks, at least as many as the opener. A shorter backtick line inside is body. The body is raw text, never decoded; its final newline before the closing fence is part of the body.

Edit sections in one file, applied in order:

````
```telo-edit path=apps/orders/telo.yaml
<<<<<<< SEARCH
    port: 8080
=======
    port: !cel "ports.http"
>>>>>>> REPLACE
<<<<<<< SEARCH
        message: !interpolate "order ${{ self.id }} failed"
=======
        message: !interpolate "order ${{ self.id }} could not be saved"
>>>>>>> REPLACE
```
````

A whole file:

````
```telo-file path=apps/orders/tests/create.yaml
kind: Telo.Sequence
metadata: { name: createOrder }
steps:
  - name: created
    invoke: !ref createOrder
```
````

A file whose content itself holds a three-backtick fence is written with a four-backtick one.

### `TextDiff.applyPatch`

A deterministic `Telo.Callable` in `text-diff`: `applyPatch(text, patch)` reads `patch` as SEARCH/REPLACE sections and applies them to `text` in order. It returns `{ applied: true, text }` or `{ applied: false, code, section, lines }` and never throws for a patch that does not apply, because the caller decides what a refusal is.

- `code` is `EDIT_BLOCK_MALFORMED` (a marker out of order or missing, or any text before the first marker or after the last), `EDIT_SECTION_ABSENT` or `EDIT_SECTION_AMBIGUOUS`. `section` counts from 1, and `lines` holds the 1-based line numbers of every match of an ambiguous section, in the text as the earlier sections left it.
- Each SEARCH must occur exactly once in the text **as the earlier sections left it**. The match is exact and byte-level. SEARCH must not be empty. REPLACE may be empty, which deletes the match.
- All or nothing: a section that fails means no `text` is returned.
- Inputs over the module's existing `maxInputBytes` are `EDIT_BLOCK_MALFORMED` with `section: null`, so the function stays bounded the way `lineDiff` is.

### `Fs.Move`

A `Telo.Invocable` in `fs` with `{ path, destination }`, both resolved against `cwd`. It renames a file or a directory in one `rename(2)` and creates missing parent directories of `destination`. It refuses before changing anything:

- an existing destination, with `ERR_PATH_EXISTS`;
- a destination inside the source, with `ERR_MOVE_INTO_ITSELF`;
- a source that is absent, with `ERR_PATH_NOT_FOUND`;
- a rename across filesystems (`EXDEV`), with `ERR_MOVE_CROSS_DEVICE`. Copying across devices is not this kind's job.

It returns `{ moved: <path>, destination }`.

### `Ai.Agent.textTools`

An optional list. Each entry maps a fence tag to a tool one of the agent's tool providers advertises, and maps the block into that tool's **`arguments`**, exactly as if the model had produced them in a JSON call:

```yaml
textTools:
  - tag: telo-edit
    tool: edit_file
    arguments:
      path: !cel "block.attributes.path"
      patch: !cel "block.body"
  - tag: telo-file
    tool: write_file
    arguments:
      path: !cel "block.attributes.path"
      content: !cel "block.body"
```

- `block` is `{ tag, attributes, body }`: `attributes` a map of strings, and `body` a string.
- Everything after `arguments` is the tool's own: the provider's `inputs:` mapping, so `context` (the authoring agent's `turnId`) reaches the call, its `approval:`, its `result:` rendering, and `maxToolResultBytes`.
- `telo check` refuses the following when the named tool is in an `Ai.Tools` provider, whose `parameters` are static:
  - a tool no provider declares;
  - an argument key the tool's `parameters` lack;
  - a required parameter left unmapped;
  - a tag listed twice.

  For a tool a provider only discovers at run time (an MCP server), the name is checked when the agent first lists its tools, with `ERR_TEXT_TOOL_UNKNOWN`. The arguments are then validated against the advertised schema at dispatch, as a JSON call's are.
- A tag must match `^[a-z][a-z0-9-]*$`. A fence whose tag is not listed is ordinary text, and a reply may hold any number of blocks.

### The loop

After each model reply:

1. **Extract** the complete blocks of listed tags, in order. Only a fence at column 0 that is not inside another fence opens a block, so a model can show a listed tag as an example by wrapping it in a longer fence of another info string (for example ```` ````text ````). A fence that opens and never closes is incomplete.
2. **Run the JSON tool calls** as today, all of them settled.
3. **Then run the blocks**, one at a time in order, so a block sees the effects of the JSON calls and of the blocks before it. `maxParallelTools` does not apply to blocks. Each block goes through the same dispatch as a JSON call: approval, the `execute_tool` span, cancellation, `onToolError`, the result bound. With `onToolError: feedback`, a block that fails stops the rest of the reply's blocks, which are reported as not run. With `throw`, the run raises as for a JSON call.
4. **Follow up** if there were blocks. The next model call replays the assistant message as the text the model wrote, blocks included. It then sends one user message: the JSON calls' `tool_result` parts first (as the Messages API requires), then one text part with the block results.
5. **End** the run, as today, on a reply with no tool calls and no blocks. Each model call still counts against `maxSteps`.

The block results reuse each tool's own `result:` rendering:

```
telo-edit apps/orders/telo.yaml: wrote apps/orders/telo.yaml
check: clean

telo-edit apps/orders/tests/create.yaml: not run (the block before it failed)
```

and for a failure:

```
telo-edit apps/orders/telo.yaml: ERR_EDIT_SECTION_AMBIGUOUS section 2 matches 3 places (lines 14, 41, 77); add surrounding lines to the SEARCH. Nothing was written.
```

### Truncation

A block still open when a reply ends with `finishReason: length` is not executed. The complete blocks before it do run. The next call carries, as that block's result:

```
telo-edit apps/orders/telo.yaml: cut off by the output limit; nothing was applied. Send it again, in smaller blocks.
```

The call counts as a step.

### The record

- **Steps.** `steps[i]` gains `textCalls: [{ tag, attributes, ok }]` beside `toolCalls`. `toolResults` gains the settled results of block-originated calls with `origin: text` and a generated id `block_<uuid>`, so a consumer treating results uniformly sees them.
- **Messages.** `messages` records the assistant message as text. The block results are a text part of the following user message, marked `kind: text-tool-results`, so a replay is exact and a projection that folds history does not mistake them for a person's words.
- **Streaming.** The streaming agent shares the extractor and the dispatch with the plain one. Block text streams out as the model writes it. Execution starts once the reply has finished (as step 3 requires) and each block's result is emitted as its own `tool-result` record with `origin: text`.

### The authoring agent

- **`edit_file`** takes either `oldString` / `newString` or `patch`, exactly one form per call (`ERR_EDIT_FORM_INVALID` otherwise).
  - The `patch` arm reads the file as the JSON arm does: bounded, UTF-8 text only. It computes the edited text with `TextDiff.applyPatch`, and a patch that does not apply is thrown as `ERR_` + its code, leading with the section and the lines, before anything is checkpointed.
  - From there it follows the JSON arm unchanged: the credential scan, the before/after copies, the checkpoint entry, the write, one `telo check`.
  - The JSON form keeps working.
- **`author` declares `textTools`** for `telo-edit` and `telo-file` as above, so the authoring agent's chat library declares `requires: telo:` at the release carrying `textTools`.
- **`move_file`** is a new tool, `{ path, destination }`, implemented over `Fs.Move`.
  - **Confinement.** Both paths are confined by `outsideWorkspace`. The source is refused by `unremovable`, and a symbolic link or a tree holding a non-file entry is refused with `ERR_PATH_NOT_A_FILE`, as for deletion. The tool runs as **one** workspace-lease hold.
  - **Checkpoint.** A move is checkpointed as the removal of every regular file under the source (the "before" copy captured, after = absent) and the creation of each at the destination (before = absent, after = the same digest), in one call, bounded by `maxCheckpointBytes` / `maxCheckpointFiles` like a recursive delete. Revert therefore restores the source files and removes the destination files with no new revert logic. Directories a revert empties stay behind, as they do after a reverted write.
  - **References.** A moved manifest's references are NOT rewritten. The result says so, and the primer tells the agent to run `telo_check` on the manifests that import it.
- **The primer**
  - teaches the blocks with the two examples above;
  - says a SEARCH should be the shortest run of whole lines that is unique, and to send one block per file;
  - says to write a listed fence only when it means to run it;
  - says a write or edit already ran `telo check`, so a separate `telo_check` is for files it did not touch;
  - names `ERR_EDIT_SECTION_ABSENT`, `ERR_EDIT_SECTION_AMBIGUOUS` and `ERR_EDIT_BLOCK_MALFORMED` and what to do for each.
- **Studio** shows a block's result like a tool result, and the block itself as the file change it is.

## Examples

**Renaming a kind used in three places** — before: three `edit_file` calls, three checks, the first two reporting `UNDEFINED_KIND`. After:

````
```telo-edit path=apps/billing/telo.yaml
<<<<<<< SEARCH
kind: Billing.Invoice
metadata: { name: invoice }
=======
kind: Billing.Receipt
metadata: { name: receipt }
>>>>>>> REPLACE
<<<<<<< SEARCH
      invoke: !ref invoice
=======
      invoke: !ref receipt
>>>>>>> REPLACE
<<<<<<< SEARCH
  - !ref invoice
=======
  - !ref receipt
>>>>>>> REPLACE
```
````

One lease, one checkpoint entry, one check on the final content: `check: clean`.

**An ambiguous anchor** — `    port: 8080` appears in two resources:

```
telo-edit apps/orders/telo.yaml: ERR_EDIT_SECTION_AMBIGUOUS section 1 matches 2 places (lines 14, 41); add surrounding lines to the SEARCH. Nothing was written.
```

The model resends with `kind: Http.Server` and the line above it in the SEARCH.

**Moving a folder:**

```
move_file { "path": "apps/orders", "destination": "apps/sales/orders" }
→ moved apps/orders to apps/sales/orders (7 files); references to it were not updated
```

The agent then runs `telo_check` on `apps/sales/telo.yaml`, which still imports `../orders`, and fixes the import with one `telo-edit` block.

**A truncated reply** — the model writes a 600-line `telo-file` block and hits the output limit at line 380. Nothing is written, the next call carries the cut-off notice, and the model resends the file as three smaller files.

## Verify

- **`text-diff` unit tests and module tests** (`modules/text-diff/tests/`):
  - three sections applied in order, each seeing the earlier ones' result;
  - section 2 absent → `EDIT_SECTION_ABSENT`, `section: 2`, no `text`;
  - a section matching twice → `EDIT_SECTION_AMBIGUOUS` with both line numbers;
  - an empty SEARCH, a stray line before the first marker, and a missing `=======` are each `EDIT_BLOCK_MALFORMED`;
  - an empty REPLACE deletes;
  - CRLF text matches only a CRLF SEARCH.
- **`fs` module tests** (`modules/fs/tests/`): a file and a directory moved, with missing parents created; an existing destination, a destination inside the source and an absent source are each refused with their code, and the tree is unchanged.
- **`ai` module tests** (`modules/ai/tests/`):
  - `textTools` naming an unknown tool, an argument the tool lacks, or a repeated tag is refused by `telo check`;
  - a discovered tool name no provider lists is `ERR_TEXT_TOOL_UNKNOWN`;
  - blocks run in order after the JSON calls under `maxParallelTools > 1`;
  - the tool's `inputs:` mapping receives `context`;
  - approval gates a block;
  - cancellation mid-block stops the run;
  - a listed fence wrapped in a longer fence of another info string is not run;
  - a four-backtick block whose body holds a three-backtick fence is passed whole;
  - `steps[].textCalls` and `messages` replay a stored run exactly;
  - the streaming agent produces the same results and records as the plain one for the same reply.
- **Offline, against the provider stub** (`apps/authoring-agent/chat/tests/`):
  - a reply with a three-section `telo-edit` block writes the file once, runs `telo check` once, and the next model call sees exactly one block result;
  - a block whose second section is absent writes nothing, records no checkpoint entry, and the result names section 2;
  - two blocks in one reply, the first failing: the second is reported `not run` and its file is untouched;
  - a reply with a block and a JSON tool call runs both, and the next call's user message carries the tool result before the block results;
  - a reply cut off inside a block runs the complete blocks before it, nothing for the cut one, and the next call carries the notice;
  - `telo-file` over an existing file is checkpointed and reverted like `write_file`;
  - `edit_file` with both forms, or neither, is `ERR_EDIT_FORM_INVALID`;
  - `move_file` of a directory is one lease hold, and one revert restores every source file and removes every destination file;
  - a move onto an existing path, into itself, of the workspace root, of the state directory or of a link is refused with its code before anything changes.
- **Live** (`authors-manifest`), read from the turn's journal:
  - no `edit_file` call fails `ERR_EDIT_SECTION_ABSENT` / `ERR_EDIT_SECTION_AMBIGUOUS` and is retried with the same SEARCH;
  - no manifest is checked more than once per model reply.

## Documentation and releases

- **`ai`**
  - Docs: `textTools`, the loop, truncation and the record in `modules/ai/docs/ai-agent.md` and `ai-agent-stream.md`, and in `modules/ai/README.md`.
  - Release: an `Added` fragment describing `textTools`.
- **`text-diff`**
  - Docs: `applyPatch` in `modules/text-diff/docs/` and the README, and the library `description` extended to name patching.
  - Release: an `Added` fragment.
- **`fs`**
  - Docs: `Fs.Move` in `modules/fs/docs/` and the README.
  - Release: an `Added` fragment.
- **The authoring agent**
  - Docs: `apps/authoring-agent/chat/primer.md`, and a "Text edits" entry in `apps/authoring-agent/CLAUDE.md`: where blocks are read, why a patch is all-or-nothing, why moves stay a tool, and how a move is checkpointed.
  - Releases: the chat library and Studio take their changesets.
- **`requires:` floors.** Only the authoring agent's chat library writes `textTools` in its own `telo.yaml`, so it alone declares `requires: telo: ">=<release that carries it>"`, verified by running the previous published CLI against it. `applyPatch` and `Fs.Move` are new kinds delivered in their own modules' artifacts and need no floor.
- **Benefits ledger.** `docs/guides/what-you-get.md` is unchanged: this is an agent capability, not a feature every Telo author gets.
