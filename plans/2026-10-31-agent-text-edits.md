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
- **One edit of one file per call.** `edit_file` replaces one substring and runs `telo check` after it. A change of three edits, in one file or across a library and its importer, is three leases, three checkpoint entries and three checks. The first check reports the dangling references the third edit would have fixed, every result is re-sent on every later step, and a failure part-way leaves the workspace half-changed.
- **No move.** There is no move or rename of a file or folder. The agent reads, writes whole at the new path and deletes the old one; a folder is that per file. Relative imports and `!module-path` / `!include-*` claims in the copies keep their old paths, and a delete past the checkpoint bound (`ERR_CHECKPOINT_TOO_LARGE`) leaves the files duplicated.
- **No copy.** Starting a file or an app from an existing one means reading it whole and writing it back: output tokens for every byte, and both the read and the write re-sent on every later step.

Telo cannot make a tool call carry raw text: the `anthropic` module speaks the API's JSON tool input, and `Ai.Agent` hands a tool a parsed `arguments` object. But a model's reply TEXT has no escaping, and the application already reads structure out of reply text (the `telo-questions` block).

## Solution

**The model writes file contents and edits as fenced blocks in its reply; `Ai.Agent` gathers a reply's blocks into ONE call of one of its own tools, runs it through the ordinary tool path, and answers with the result.** For the authoring agent that call is one change set: every file checked before any is written, one lease hold, one checkpoint call, one `telo check` over every touched file. Four parts:

- `ai`: `Ai.Agent.textTools` — extracting blocks and dispatching them, grouped per reply.
- `text-diff`: `TextDiff.applyPatch` — applying a SEARCH/REPLACE patch to a text, as a pure function beside `lineDiff`.
- `fs`: `Fs.Move` — a rename of a file or directory — and `Fs.Copy` — a copy of one.
- The authoring agent: a new `apply_changes` tool that takes a reply's blocks, and new `move_file` and `copy_file` tools. Moves and copies stay JSON tools: each carries two short paths and nothing to escape.

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

A file whose content itself holds a three-backtick fence is written with a four-backtick one. A reply may hold any number of blocks, for any number of files.

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

### `Fs.Copy`

A `Telo.Invocable` in `fs` with `{ path, destination }`, both resolved against `cwd`. It copies a file, or a directory with everything beneath it, and creates missing parent directories of `destination`. Copying across filesystems is allowed.

- **All or nothing.** The copy is built in a temporary sibling of `destination` and moved into place with one `rename(2)`. A failure part-way removes the temporary copy, then raises the failure, so no partial destination is left.
- It refuses before changing anything:
  - an existing destination, with `ERR_PATH_EXISTS`;
  - a destination inside the source, with `ERR_COPY_INTO_ITSELF`;
  - a source that is absent, with `ERR_PATH_NOT_FOUND`;
  - a symbolic link or a special file anywhere in the source, with `ERR_COPY_UNSUPPORTED_ENTRY`. The kind does not decide what copying a link means.

It returns `{ copied: <path>, destination, files }`, `files` the number of regular files copied.

### `Ai.Agent.textTools`

An optional list. Each entry names the fence tags it collects and a tool one of the agent's tool providers advertises. It maps **all of a reply's blocks with those tags** into that tool's **`arguments`**, exactly as if the model had produced them in one JSON call:

```yaml
textTools:
  - tags: [telo-edit, telo-file]
    tool: apply_changes
    arguments:
      changes: !cel >-
        blocks.map(b, b.tag == 'telo-edit'
          ? { 'path': b.attributes.path, 'patch': b.body }
          : { 'path': b.attributes.path, 'content': b.body })
```

- `blocks` is the list of the reply's blocks whose tag the entry lists, in reply order, each `{ tag, attributes, body }`: `attributes` a map of strings, `body` a string. An entry yields at most one call per reply, and none when the reply holds none of its tags. A tool that acts per block takes a list and iterates it.
- An `arguments` expression that fails to evaluate (a block missing an attribute the mapping reads) fails the call with the evaluation error. The tool is not dispatched.
- Everything after `arguments` is the tool's own: the provider's `inputs:` mapping, so `context` (the authoring agent's `turnId`) reaches the call, its `approval:` (one approval for the whole set), its `result:` rendering, and `maxToolResultBytes`.
- `telo check` refuses the following when the named tool is in an `Ai.Tools` provider, whose `parameters` are static:
  - a tool no provider declares;
  - an argument key the tool's `parameters` lack;
  - a required parameter left unmapped;
  - a tag listed in two entries, or twice in one.

  For a tool a provider only discovers at run time (an MCP server), the name is checked when the agent first lists its tools, with `ERR_TEXT_TOOL_UNKNOWN`. The arguments are then validated against the advertised schema at dispatch, as a JSON call's are.
- A tag must match `^[a-z][a-z0-9-]*$`. A fence whose tag is not listed is ordinary text.

### The loop

After each model reply:

1. **Extract** the complete blocks of listed tags, in order. Only a fence at column 0 that is not inside another fence opens a block, so a model can show a listed tag as an example by wrapping it in a longer fence of another info string (for example ```` ````text ````). A fence that opens and never closes is incomplete.
2. **Run the JSON tool calls** as today, all of them settled.
3. **Then run the text calls**: one per entry whose tags the reply holds, ordered by each entry's first block, one at a time, so a call sees the effects of the JSON calls and of the text calls before it. `maxParallelTools` does not apply to them. Each goes through the same dispatch as a JSON call: approval, the `execute_tool` span, cancellation, `onToolError`, the result bound. With `onToolError: feedback`, a call that fails stops the reply's later text calls, which are reported as not run. With `throw`, the run raises as for a JSON call.
4. **Follow up** if there were blocks. The next model call replays the assistant message as the text the model wrote, blocks included. It then sends one user message: the JSON calls' `tool_result` parts first (as the Messages API requires), then one text part with the text calls' results.
5. **End** the run, as today, on a reply with no tool calls and no blocks. Each model call still counts against `maxSteps`.

Each text call's result is headed by its tool and the blocks it carried, then the tool's own `result:` rendering:

```
apply_changes (telo-edit path=apps/orders/telo.yaml, telo-file path=apps/orders/tests/create.yaml):
wrote apps/orders/telo.yaml, apps/orders/tests/create.yaml
check: clean
```

and for a failure:

```
apply_changes (telo-edit path=apps/orders/telo.yaml, telo-file path=apps/orders/tests/create.yaml):
ERR_EDIT_SECTION_AMBIGUOUS change 1 (apps/orders/telo.yaml) section 2 matches 3 places (lines 14, 41, 77); add surrounding lines to the SEARCH. Nothing was written.
```

### Truncation

When a reply ends with `finishReason: length` while a listed block is still open, **none of the reply's blocks run**, since the change set they form is incomplete. The next call carries, as the result:

```
cut off by the output limit inside telo-file path=apps/orders/tests/create.yaml; no block of this reply was run. Send the change again in smaller blocks.
```

The call counts as a step. A change too large for one reply is split by the model across replies, and each reply's blocks form a change set of their own.

### The record

- **Steps.** `steps[i]` gains `textCalls: [{ tool, blocks: [{ tag, attributes }], ok }]` beside `toolCalls`. `toolResults` gains the settled results of text calls with `origin: text` and a generated id `block_<uuid>`, so a consumer treating results uniformly sees them.
- **Messages.** `messages` records the assistant message as text. The text calls' results are a text part of the following user message, marked `kind: text-tool-results`, so a replay is exact and a projection that folds history does not mistake them for a person's words.
- **Streaming.** The streaming agent shares the extractor and the dispatch with the plain one. Block text streams out as the model writes it. Execution starts once the reply has finished (as step 3 requires) and each text call's result is emitted as its own `tool-result` record with `origin: text`.

### The authoring agent

- **`apply_changes`** is a new tool, `{ changes }`: a non-empty list, in order, of `{ path, patch }` (a SEARCH/REPLACE patch) or `{ path, content }` (the whole file). A change with both or neither is `ERR_CHANGE_FORM_INVALID`.
  - **Everything is decided before anything is written**, inside **one** workspace-lease hold:
    - every path confined by `outsideWorkspace`;
    - each patched file read as `edit_file` reads it (bounded, UTF-8 text only);
    - changes naming one path composed in order, so a `telo-file` followed by a `telo-edit` of the same path edits the new content;
    - every resulting text passed through the credential scan;
    - the "before" copies of every distinct path counted together against `maxCheckpointBytes` / `maxCheckpointFiles`, as a recursive delete counts them.

    Any refusal is thrown before anything is checkpointed or written. A patch that does not apply is thrown as `ERR_` + its code, leading with the change's position (its block's position in the call), its path, the section and the lines.
  - **Then, in the same hold,** one checkpoint entry per distinct path (before = the file as it was, after = its final text), the writes in path order, each entry confirmed. A refusal leaves every file untouched. A disk failure part-way through the writes leaves the files already written; settlement confirms those entries as for any failed write, and a revert restores them.
  - **Then one `telo check` over every distinct path at once**, the check `write_file` runs, over the final content of the whole set.
  - The result is `wrote <path>, <path>, …` then the check rendering. The structured output carries each path's change and hunks for Studio, as `write_file`'s does.
  - It is advertised as a JSON tool as well; its description points the model at the blocks.
- **`write_file` and `edit_file`** are unchanged. The primer steers file changes to blocks, and stored conversations keep replaying calls that name the old tools.
- **`author` declares `textTools`** with the one entry above, so the authoring agent's chat library declares `requires: telo:` at the release carrying `textTools`.
- **`move_file`** is a new tool, `{ path, destination }`, implemented over `Fs.Move`.
  - **Confinement.** Both paths are confined by `outsideWorkspace`. The source is refused by `unremovable`, and a symbolic link or a tree holding a non-file entry is refused with `ERR_PATH_NOT_A_FILE`, as for deletion. The tool runs as **one** workspace-lease hold.
  - **Checkpoint.** A move is checkpointed as the removal of every regular file under the source (the "before" copy captured, after = absent) and the creation of each at the destination (before = absent, after = the same digest), in one call, bounded by `maxCheckpointBytes` / `maxCheckpointFiles` like a recursive delete. Revert therefore restores the source files and removes the destination files with no new revert logic. Directories a revert empties stay behind, as they do after a reverted write.
  - **References.** A moved manifest's references are NOT rewritten. The result says so, and the primer tells the agent to run `telo_check` on the manifests that import it.
- **`copy_file`** is a new tool, `{ path, destination }`, implemented over `Fs.Copy`.
  - **Confinement.** Both paths are confined by `outsideWorkspace`, and a symbolic link or a tree holding a non-file entry is refused with `ERR_PATH_NOT_A_FILE`, as for a move. The tool runs as **one** workspace-lease hold.
  - **Checkpoint.** A copy is checkpointed as the creation of each regular file at the destination (before = absent, after = the source file's digest), in one call, bounded by `maxCheckpointBytes` / `maxCheckpointFiles`. Revert therefore removes every copied file with no new revert logic.
  - **References.** A copy is NOT rewritten: a copied manifest keeps its `metadata.name`, and its relative imports and `!module-path` / `!include-*` claims break when the copy sits at another depth. The result says so, and the primer tells the agent to edit the copy before anything uses it.
- **The primer**
  - teaches the blocks with the two examples above;
  - says a reply's blocks are applied together or not at all and checked once, so a change spanning files goes in one reply;
  - says a SEARCH should be the shortest run of whole lines that is unique, and to send one block per file;
  - says to write a listed fence only when it means to run it;
  - says to start a file or an app from an existing one with `copy_file`, then edit the copy, rather than reading it and writing it whole;
  - says a change set already ran `telo check` on every file it touched, so a separate `telo_check` is for files it did not touch;
  - names `ERR_EDIT_SECTION_ABSENT`, `ERR_EDIT_SECTION_AMBIGUOUS`, `ERR_EDIT_BLOCK_MALFORMED` and `ERR_CHANGE_FORM_INVALID` and what to do for each.
- **Studio** shows a text call's result like a tool result, and each of its blocks as the file change it is.

## Examples

**Renaming a kind across a library and its importer** — before: three `edit_file` calls and three checks, the first two reporting `UNDEFINED_KIND`, and a failure on the third leaves two edits applied. After, one reply:

````
```telo-edit path=apps/billing/telo.yaml
<<<<<<< SEARCH
kind: Telo.Definition
metadata: { name: Invoice }
=======
kind: Telo.Definition
metadata: { name: Receipt }
>>>>>>> REPLACE
<<<<<<< SEARCH
  - Invoice
=======
  - Receipt
>>>>>>> REPLACE
```

```telo-edit path=apps/shop/telo.yaml
<<<<<<< SEARCH
kind: Billing.Invoice
=======
kind: Billing.Receipt
>>>>>>> REPLACE
```
````

One `apply_changes` call: one lease hold, one checkpoint call, one check over both files' final content, `check: clean`.

**An ambiguous anchor** — `    port: 8080` appears in two resources:

```
apply_changes (telo-edit path=apps/orders/telo.yaml):
ERR_EDIT_SECTION_AMBIGUOUS change 1 (apps/orders/telo.yaml) section 1 matches 2 places (lines 14, 41); add surrounding lines to the SEARCH. Nothing was written.
```

The model resends with `kind: Http.Server` and the line above it in the SEARCH.

**Moving a folder:**

```
move_file { "path": "apps/orders", "destination": "apps/sales/orders" }
→ moved apps/orders to apps/sales/orders (7 files); references to it were not updated
```

The agent then runs `telo_check` on `apps/sales/telo.yaml`, which still imports `../orders`, and fixes the import with one `telo-edit` block. When it already knows the importer, one reply holds both: the `move_file` call runs first, then the block, whose check confirms the import.

**Starting an app from an existing one:**

```
copy_file { "path": "apps/orders", "destination": "apps/invoices" }
→ copied apps/orders to apps/invoices (7 files); references in the copy were not updated
```

In the next reply the agent renames the copy's `metadata.name` and changes what differs, in `telo-edit` blocks that form one change set.

**A truncated reply** — the model writes a 600-line `telo-file` block and an edit of the application that imports it, and hits the output limit at line 380 of the file. Neither is written, the next call carries the cut-off notice, and over the following replies the model resends the file as three smaller files, the edit with the last of them.

## Verify

- **`text-diff` unit tests and module tests** (`modules/text-diff/tests/`):
  - three sections applied in order, each seeing the earlier ones' result;
  - section 2 absent → `EDIT_SECTION_ABSENT`, `section: 2`, no `text`;
  - a section matching twice → `EDIT_SECTION_AMBIGUOUS` with both line numbers;
  - an empty SEARCH, a stray line before the first marker, and a missing `=======` are each `EDIT_BLOCK_MALFORMED`;
  - an empty REPLACE deletes;
  - CRLF text matches only a CRLF SEARCH.
- **`fs` module tests** (`modules/fs/tests/`):
  - a file and a directory moved, with missing parents created; an existing destination, a destination inside the source and an absent source are each refused with their code, and the tree is unchanged;
  - a file and a directory copied, with missing parents created, the source unchanged; an existing destination, a destination inside the source, an absent source and a source holding a symbolic link are each refused with their code, and the tree is unchanged;
  - a copy failing part-way (an unreadable file deep in the source) raises and leaves no destination and no temporary copy.
- **`ai` module tests** (`modules/ai/tests/`):
  - `textTools` naming an unknown tool, an argument the tool lacks, or a tag listed in two entries is refused by `telo check`;
  - a discovered tool name no provider lists is `ERR_TEXT_TOOL_UNKNOWN`;
  - an entry listing two tags receives ONE call per reply, with both tags' blocks in reply order;
  - two entries yield two calls, ordered by each entry's first block, after the JSON calls under `maxParallelTools > 1`;
  - with `onToolError: feedback`, a failing first text call reports the second as not run;
  - a block missing an attribute the mapping reads fails the call with the evaluation error, and the tool is not dispatched;
  - the tool's `inputs:` mapping receives `context`;
  - approval gates a text call once for all its blocks;
  - cancellation mid-call stops the run;
  - a reply cut off inside a listed block runs none of its blocks and carries the notice;
  - a listed fence wrapped in a longer fence of another info string is not run;
  - a four-backtick block whose body holds a three-backtick fence is passed whole;
  - `steps[].textCalls` and `messages` replay a stored run exactly;
  - the streaming agent produces the same results and records as the plain one for the same reply.
- **Offline, against the provider stub** (`apps/authoring-agent/chat/tests/`):
  - a reply with a three-section `telo-edit` block writes the file once, runs `telo check` once, and the next model call sees exactly one result;
  - a reply with blocks for two files is one `apply_changes` call: one lease hold, one checkpoint call, one `telo check` naming both files, one result;
  - a reply whose first block applies and whose second block's section is absent writes neither file, records no checkpoint entry, and the result names change 2 and its section;
  - a credential in the second file refuses the whole set, and the first file is untouched;
  - the checkpoint bounds are counted across the set: two files each under `maxCheckpointBytes` but over it together are `ERR_CHECKPOINT_TOO_LARGE`, nothing written;
  - a `telo-file` followed by a `telo-edit` of the same path writes the edited content, with one checkpoint entry for the path;
  - one revert of the turn restores every file of the set;
  - a reply with a block and a JSON tool call runs both, and the next call's user message carries the tool result before the text call's result;
  - a reply cut off inside a block writes nothing, and the next call carries the notice;
  - `telo-file` over an existing file is checkpointed and reverted like `write_file`;
  - an `apply_changes` change with both `patch` and `content`, or neither, is `ERR_CHANGE_FORM_INVALID`;
  - `move_file` of a directory is one lease hold, and one revert restores every source file and removes every destination file;
  - a move onto an existing path, into itself, of the workspace root, of the state directory or of a link is refused with its code before anything changes;
  - `copy_file` of a directory is one lease hold, and one revert removes every copied file and leaves the source untouched;
  - a copy onto an existing path, into itself, out of the workspace, of the state directory or of a link is refused with its code before anything changes;
  - a copy over the checkpoint bounds is `ERR_CHECKPOINT_TOO_LARGE`, nothing copied.
- **Live** (`authors-manifest`), read from the turn's journal:
  - no `apply_changes` call fails `ERR_EDIT_SECTION_ABSENT` / `ERR_EDIT_SECTION_AMBIGUOUS` and is retried with the same SEARCH;
  - every model reply that changes files does so in at most one `apply_changes` call, so its files are checked once.

## Documentation and releases

- **`ai`**
  - Docs: `textTools`, the grouping per reply, the loop, truncation and the record in `modules/ai/docs/ai-agent.md` and `ai-agent-stream.md`, and in `modules/ai/README.md`.
  - Release: an `Added` fragment describing `textTools`.
- **`text-diff`**
  - Docs: `applyPatch` in `modules/text-diff/docs/` and the README, and the library `description` extended to name patching.
  - Release: an `Added` fragment.
- **`fs`**
  - Docs: `Fs.Move` and `Fs.Copy` in `modules/fs/docs/` and the README.
  - Release: one `Added` fragment naming both kinds.
- **The authoring agent**
  - Docs: `apps/authoring-agent/chat/primer.md`, and a "Text edits" entry in `apps/authoring-agent/CLAUDE.md`: where blocks are read, why a reply's blocks are one change set (one check over the final state, nothing half-applied), why a patch is all-or-nothing, why moves and copies stay tools, and how each is checkpointed.
  - Releases: the chat library and Studio take their changesets.
- **`requires:` floors.** Only the authoring agent's chat library writes `textTools` in its own `telo.yaml`, so it alone declares `requires: telo: ">=<release that carries it>"`, verified by running the previous published CLI against it. `applyPatch`, `Fs.Move` and `Fs.Copy` are new kinds delivered in their own modules' artifacts and need no floor.
- **Benefits ledger.** `docs/guides/what-you-get.md` is unchanged: this is an agent capability, not a feature every Telo author gets.
