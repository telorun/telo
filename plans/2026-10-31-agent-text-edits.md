# Raw-text edits and moves for the authoring agent

## Problem

The authoring agent changes files only through JSON tool calls, and that costs it in three ways.

- **Escaping.** A tool call's arguments are one JSON object (the Messages API's `tool_use.input`; `Ai.Agent` raises anything else). `write_file.content` and `edit_file.oldString` / `newString` are JSON strings, so the model escapes every newline, quote and backslash of a manifest. CEL is full of quotes and already doubly escaped (`'\\n'`), and a block scalar is indentation-sensitive. A slip makes `oldString` absent or non-unique, and the agent retries.
- **One edit per call.** `edit_file` replaces one substring and runs `telo check` after it. Three edits to one manifest are three leases, three checkpoint entries, three checks — and the first check reports the dangling references the third edit would have fixed. Every result is re-sent on every later step.
- **No move.** There is no move or rename of a file or folder. The agent reads, writes whole at the new path and deletes the old one; a folder is that per file. Relative imports and `!module-path` / `!include-*` claims in the copies keep their old paths, and a delete past the checkpoint bound (`ERR_CHECKPOINT_TOO_LARGE`) leaves the files duplicated.

Telo cannot make a tool call carry raw text: the `anthropic` module speaks the API's JSON tool input, and `Ai.Agent` hands a tool a parsed `arguments` object. But a model's reply TEXT has no escaping, and the application already reads structure out of reply text (the `telo-questions` block).

## Solution

**The model writes file content and edits as fenced blocks in its reply; `Ai.Agent` executes them through the existing tools and answers with their results.** Two parts: a generic capability in `ai`, and the authoring agent's use of it. Moves stay an ordinary tool, since a move carries two short paths and nothing to escape.

### The blocks

A block is a fenced region whose info string is a tag followed by `name=value` attributes; the body is raw text, never decoded.

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
kind: Test.Suite
metadata: { name: createOrder }
tests:
  - name: creates
    invoke: { kind: Run.Sequence, steps: [] }
```
````

Rules, all of which the edit tool enforces and none of which the agent knows:

- Each SEARCH must occur exactly once in the file **as the previous sections left it**. Zero or several matches fail the whole block, naming the section's index (counted from 1) and whether it was absent or ambiguous.
- Sections apply in order and **all or nothing**: a failing section writes nothing for that block.
- A SEARCH or REPLACE may be empty only for the insert/delete spellings: an empty SEARCH is refused (nothing to anchor); an empty REPLACE deletes the match.
- Text before the first marker or after the last, inside the fence, is refused (`ERR_EDIT_BLOCK_MALFORMED`), so a stray line is never silently dropped.
- Fences longer than three backticks are honoured, so a file that itself contains a fence is written with a longer one.

### `Ai.Agent.textTools`

An optional list; each entry maps a fence tag to a tool one of the agent's tool providers offers, and says how the block becomes that tool's inputs.

```yaml
textTools:
  - tag: telo-edit
    tool: edit_file
    inputs:
      path: !cel "block.attributes.path"
      patch: !cel "block.body"
  - tag: telo-file
    tool: write_file
    inputs:
      path: !cel "block.attributes.path"
      content: !cel "block.body"
```

- `block` is `{ tag, attributes, body }`, typed. `inputs:` is checked against the named tool's `parameters` like any tool entry's, so a mapping to a field the tool lacks, or a tool no provider offers, is refused by `telo check`.
- `edit_file` gains a `patch` parameter beside `oldString` / `newString`; exactly one form is allowed per call. The JSON form keeps working.
- A tag may appear once; a tag that is not listed is ordinary text.

### The loop

After each model reply:

1. Extract the **complete** blocks of listed tags, in order. A fence that opens and never closes is incomplete.
2. If the reply has JSON tool calls, run them as today.
3. Run the blocks **one at a time, in order** (edits to one file depend on each other, so `maxParallelTools` does not apply to them). Each is dispatched through the same path as a JSON call: approval (`approval:` on the tool entry applies, with `arguments` being the mapped inputs), the `execute_tool` span, cancellation, `onToolError`, the tool-result bound. A block that fails stops the rest of the reply's blocks, which are reported as not run.
4. If there were blocks, the next model call follows: the assistant message replayed as the text the model wrote, blocks included, then a user message carrying — after any JSON tool results the same turn produced — one result per block.
5. A reply with no tool calls and no blocks ends the run, as today. A run that uses blocks counts each model call against `maxSteps` as before.

The result message, one entry per block, reuses each tool's own `result:` rendering:

```
telo-edit apps/orders/telo.yaml: wrote apps/orders/telo.yaml
check: clean

telo-edit apps/orders/tests/create.yaml: not run (the block before it failed)
```

and for a failure:

```
telo-edit apps/orders/telo.yaml: ERR_EDIT_SECTION_AMBIGUOUS section 2 matches 3 places; add surrounding lines to the SEARCH. Nothing was written.
```

### Truncation

A block still open when a reply ends with `finishReason: length` is not executed. The next call tells the model:

```
telo-edit apps/orders/telo.yaml: cut off by the output limit; nothing was applied. Send it again, in smaller blocks.
```

The call counts as a step. Complete blocks before the cut-off block do run.

### The record

- `steps[i]` gains `textCalls: [{ tag, attributes, ok }]` beside `toolCalls`; `toolResults` gains the settled results of block-originated calls with `origin: text` and a generated id `block_<uuid>`, so a consumer treating results uniformly sees them.
- `messages` records the assistant message as text and the result message as a user message marked `kind: text-tool-results`, so a replay is exact and a projection that folds history does not mistake them for a person's words.
- The streaming agent shares the extractor and the dispatch with the plain one. Block text streams out as the model writes it, and execution begins when the fence closes; a block's result is emitted as its own record, like a tool result.

### The authoring agent

- `author` declares `textTools` for `telo-edit` and `telo-file` as above. `edit_file` and `write_file` stay as JSON tools.
- `move_file` is a new tool: `{ path, destination }`, both confined by `outsideWorkspace`, works on a file or a directory, and runs as **one** workspace-lease hold. It refuses an existing destination (`ERR_PATH_EXISTS`), moving a directory into itself (`ERR_PATH_OUTSIDE_WORKSPACE`'s sibling check, same message style), and the workspace root and the state directory exactly as `unremovable` does. Symbolic links and devices are `ERR_PATH_NOT_A_FILE`, as for deletion.
- A move is checkpointed as the removal of every file at the source (capture "before" copy, after = absent) and the creation of every file at the destination (before = absent, after = the same digest), inside one call, bounded by `maxCheckpointBytes` / `maxCheckpointFiles` like a recursive delete. Revert therefore restores the source files and removes the destination files with no new revert logic. A moved manifest's references are NOT rewritten: the result lists nothing and the primer tells the agent to run `telo_check` on the manifests that import it.
- The primer teaches the blocks with the two examples above, says an edit block's SEARCH should be the shortest unique run of lines, says to use one block per file, and says a write or edit already ran `telo check`, so a separate `telo_check` call after it is for files it did not touch. It names `ERR_EDIT_SECTION_ABSENT`, `ERR_EDIT_SECTION_AMBIGUOUS` and `ERR_EDIT_BLOCK_MALFORMED` and what to do for each.
- Studio shows a block's result like a tool result and the block itself as the file change it is.

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
telo-edit apps/orders/telo.yaml: ERR_EDIT_SECTION_AMBIGUOUS section 1 matches 2 places (lines 14 and 41); add surrounding lines to the SEARCH. Nothing was written.
```

The model resends with `kind: Http.Server` and the line above it in the SEARCH.

**Moving a folder:**

```
move_file { "path": "apps/orders", "destination": "apps/sales/orders" }
→ moved apps/orders to apps/sales/orders (7 files)
```

then `telo_check` on `apps/sales/telo.yaml`, which still imports `../orders`; the agent fixes the import with one `telo-edit` block.

**A truncated reply** — the model writes a 600-line `telo-file` block and hits the output limit at line 380: nothing is written; the next call carries the cut-off notice; the model resends the file as three smaller files.

## Verify

Before / after, by test:

- **Offline, against the provider stub** (`apps/authoring-agent/chat/tests/`):
  - a reply with a three-section `telo-edit` block writes the file once, runs `telo check` once, and the next model call sees exactly one result for the block;
  - a block whose second section is absent writes nothing, and the result names section 2;
  - a section matching twice writes nothing and names the section, with the lines;
  - two blocks in one reply, the first failing: the second is reported `not run` and the file it names is untouched;
  - a reply with a block and a JSON tool call runs both, tool result first;
  - a reply cut off inside a block executes nothing for that block, runs the complete blocks before it, and the next call carries the notice;
  - a fence of four backticks around a body containing a three-backtick fence writes the body whole;
  - `telo-file` over an existing file is checkpointed and reverted like `write_file`;
  - `move_file` of a directory is one lease hold, one revert restores every source file and removes every destination file, and a move onto an existing path, into itself, of the root, or of a link is refused with its code before anything changes.
- **Module tests** (`modules/ai/tests/`): `textTools` mapping to an unknown tool, a field the tool lacks, or a repeated tag is refused by `telo check`; blocks run sequentially and in order under `maxParallelTools > 1`; approval gates a block; cancellation mid-block stops the run; `steps[].textCalls` and `messages` replay a stored run exactly; the streaming agent produces the same results and records as the plain one for the same reply.
- **Live** (`authors-manifest`): the case that edits an existing manifest completes with fewer `edit_file` / `telo_check` calls than the current run, and with no escaping retry.

## Documentation and releases

- `modules/ai/docs/ai-agent.md` and `ai-agent-stream.md`: `textTools`, the loop, truncation, the record; `modules/ai/README.md`.
- `apps/authoring-agent/chat/primer.md`, and the `CLAUDE.md` of `apps/authoring-agent` (a "Text edits" entry: where blocks are read, why sections are all-or-nothing, why moves stay a tool, how a move is checkpointed).
- `ai` takes a release fragment (`Added`, describing `textTools`); the authoring agent's chat library and Studio take their changesets. Every module whose own `telo.yaml` uses `textTools` declares `requires: telo: ">=<release that carries it>"`, verified by running the previous published CLI against it.
- `docs/guides/what-you-get.md` is unchanged: this is an agent capability, not a feature every Telo author gets.
