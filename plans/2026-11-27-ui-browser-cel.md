---
status: draft
priority: medium
depends-on: []
packages: [analyzer/nodejs, kernel/nodejs, sdk, templating/nodejs, templating/rust, cli/nodejs, modules/ui, modules/ui-react, modules/queue, modules/queue-sql, modules/crud-ui, packages/ide-support, apps/studio, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
refinement: not-started
---

# Browser-evaluated CEL for ui

## Problem

What a page decides in the browser is written as `!cel` that is never evaluated. An `x-telo-eval: accessor` field holds a plain chain (`data.signedIn`) that `telo check` types, the kernel turns into a path (`{ root, path }`), and the renderer walks. Anything beyond a member read is `ACCESSOR_NOT_PLAIN_CHAIN`, so logic is pushed into a second language. Today a sign-in gate reads:

- `shown: { at: !cel "data.signedIn", matches: { const: false } }`. That is a CEL path plus a JSON Schema to say "is false".
- `enabled: { at: !cel "values.email", matches: { type: string, minLength: 3 }, disabledText: … }`. This gives one reason however many causes there are, drawn as text beside the button.

A tag saying CEL on something no CEL engine runs misleads every reader. A condition that cannot say `row.status != 'archived' && size(row.tags) < variables.maxTags` forces either a server round trip or a schema contortion. The disabled reason sits beside the button as loose text, where every established UI puts it in a tooltip on a focusable control.

## Constraints

- we use `@telorun/cel` in browser and mark which functions are safe to run there, the rest is an analysis error at check. Eg. crypto functions should not pass the check since they can't run in browser (yet).
- a button should not show anything beside it

## Surface

**Added**
- `Telo.CelEnvironment`: a built-in kind declaring what an evaluator outside the kernel supplies. `hostBacked` lists the host-backed catalog functions it binds (an enum generated from the catalog's flags), and `deterministic` (default `true`) admits no clock or random function.
- `x-telo-eval: { mode: delegated, environment: <Alias>.<Name> }`: a field whose CEL is type-checked by the kernel and evaluated by whoever consumes the resource's output.
- `x-telo-context-eval: delegated`: a root that exists only at delegated sites.
- `!path`: the tag for a field that names a place. It is a plain chain in CEL member syntax, delivered as `{ root, path }`.
- `Ui.Renderer`: `ui`'s exported `Telo.CelEnvironment`, with `hostBacked: [json, base64Encode, base64Decode]`. It is the contract every renderer meets.
- `{ expression, location, chain? }`: the delivered value of a delegated field and its wire leaf.
  - `expression` is canonical CEL source with `variables` substituted.
  - `location` is `{ module, file, line, column }`.
  - `chain: { root, path }` is present exactly when the expression is a plain member chain.
- `ctx.resolveBuiltinBrowserEntry(specifier)`: a controller's handle on a browser entry the running telo release ships. It returns the existing browser-entry files shape.
- `browserEntries`: a section of the `Telo.Builtins` archive (`specifier`, `abi`, `exports`), printed by `telo builtins`. Its first entry is `@telorun/cel`.
- The `browser` layer of `oci://ghcr.io/telorun/telo@<version>`, plus the same file in the CLI package. In a checkout the file is built into `<cache root>/browser-src/`.
- `EVAL_ENVIRONMENT_INVALID` / `ERR_EVAL_ENVIRONMENT_INVALID`: an `environment` naming no `Telo.CelEnvironment`, or written beside another mode.
- `PATH_OUTSIDE_ACCESSOR` / `ERR_PATH_OUTSIDE_ACCESSOR`: a `!path` anywhere but an accessor site.
- `ERR_FUNCTION_CALL_UNBOUND` and `ERR_CEL_UNKNOWN_IDENTIFIER`: the kernel's refusals when it prepares a delegated value at creation.
- `UI_COLUMN_HEADER_REQUIRED` / `ERR_UI_COLUMN_HEADER_REQUIRED`: a `list` or table column whose value is not a plain chain and that writes no `header`.
- `value-error`: an inline `ui-react` part drawn in place of a delegated value that failed to evaluate. It shows the `ui` keyed text `valueUnavailable` ("Unavailable").
- `modules/ui/conformance/enablement.json`: vectors for rule order and for an evaluation error counting as failing.

**Changed**
- `Ui.Condition`: now a boolean `!cel` delegated to `Ui.Renderer`. `visible: !cel "!data.signedIn"`.
- `shown` → `visible`, on:
  - every `Ui.Node` branch, both `list` column forms, `Ui.Field` (so every field kind) and `Ui.FieldGroup`
  - on the wire, every `Ui.SpecNode` branch, both wire column forms, and the wire field and group branches
  - the wire sub-schema `telo:Ui/SpecNode#/$defs/Shown` becomes `#/$defs/Visible`
  - `Ui.TabBarNavigation.visible` (an integer tab count, on a navigation placement) and `Ui.ButtonDisplay`'s `label: shown | hidden` values are other namespaces and stay.
- `Ui.Enablement` (`enabled` on a call, a `Ui.Move` and a form's `onSubmit`) is either one rule `{ condition, message }` or a non-empty list of rules.
  - `condition` is a delegated boolean, and `message` a required, non-empty `Ui.BoundText`.
  - The control can be pressed while every condition holds; otherwise the first failing rule's message is shown.
  - On the wire it is always a list.
- These become delegated (real CEL, evaluated in the browser):
  - the `value` / `time` / `markdown` nodes' `value`, and `markdown.annotations` `rows` / `line` / `count`
  - `list` `rows` and column `value`
  - a style rule's `by`, and `Ui.BoundText` `values`
  - `Ui.Address` / `Ui.RequestTarget` / `Ui.InvalidationTarget` `path` (when not a literal template), `pathParams` and `queryParams`
  - `Ui.OpenPage` `pathParams` / `queryParams`
  - a call's `inputs`, and `Ui.Listing` `filters`
  - `Ui.Query` `input.body` (`accessor-template` leaves)
  - `Ui.Form` `record.key` and `initialValues`
  - a relation's `label` / `hint`
  - component and layout `props`, and `rowStyle` / column `style`
- These are written `!path` (they name a place):
  - an option source's `value`
  - the `command` node's `command`
  - `Queue.GroupBy`
- The browser roots `data`, `query`, `params`, `values`, `row`, `result`, `input`, `error`, `form` and `prompt` exist at `delegated`, and also at `accessor` where a `!path` field reads them.
- `ACCESSOR_NOT_PLAIN_CHAIN` is also raised for `!cel` / `!interpolate` at an accessor field, with a fix rewriting it to `!path`.
- `FUNCTION_CALL_UNBOUND` also covers a delegated site's module call, a host-backed function its environment does not list, and a non-deterministic function, naming the environment and the reason.
- `CEL_UNKNOWN_IDENTIFIER` also covers kernel state read at a delegated site (`secrets`, `resources`, `ports`, `request`, `inputs`, `steps`, `self`), and a `variables` read whose type has no CEL literal spelling.
- `CEL_NULLABLE_ACCESS` applies at delegated sites. Accessor sites dropped it.
- `@telorun/ui-react-renderer` and `@telorun/ui-react` list `@telorun/cel` under `external`. `UiReact.App` maps it in the page's import map.
- A disabled control in `ui-react` is `aria-disabled="true"` and stays focusable. Its reason is a `Tooltip` linked by `aria-describedby`, and a disabled row-action menu item behaves the same.

**Removed**
- `Ui.Condition`'s `{ at, matches }`, and `Ui.Enablement`'s `at`, `matches` and `disabledText`.
- The `shown` key, renamed `visible`. Written on any node, field or group, it is `SCHEMA_VIOLATION`.
- `x-telo-match-for`, `MATCH_UNSATISFIABLE` and `MATCH_FOR_INVALID`.
- `!cel` at accessor fields.
- The `disabled-text` part.

## Solution

**Delegated fields.** A field marked `x-telo-eval: { mode: delegated, environment: Ui.Renderer }` holds real CEL. `telo check` types it against the roots in scope there and against the environment:
- A module call, a host-backed function the environment does not list (`sha256`, `hmac`, `joinPath`), or `now()` / `uuidv4()` under `deterministic: true` is `FUNCTION_CALL_UNBOUND`. The message names `Ui.Renderer` and the reason.
- Kernel state is `CEL_UNKNOWN_IDENTIFIER`.

`secrets` and `resources` never leave the kernel. That is a rule of the mode, not an environment option, so no environment can admit them. `variables` may be read and is substituted as a literal.

At creation the kernel parses and judges each delegated value with the same judgement. That covers a dependency's resources, which the load analysis does not judge. It then substitutes variables and writes the expression back with the engine's canonical serializer. An expression that reads no browser root after substitution is evaluated there and delivered as `{ value }`. Delegated values are forwarded through templates and `base:` children as written, as accessor values are today. `!interpolate` at a delegated site crosses as the CEL it means.

**What the browser runs.** The renderer evaluates with the running telo's own engine, never a copy fixed when `ui-react` was published. The kernel offers the release's browser entries through `ctx.resolveBuiltinBrowserEntry`, listed as data in the archive's `browserEntries`. `UiReact.App` serves `@telorun/cel` content-addressed by its digest and maps it in the import map. An `abi` it does not accept is `ERR_BROWSER_ENTRY_ABI_UNSUPPORTED`. A future `abi` bump is answered by a `restrictions:` ceiling on `ui-react`.

The renderer compiles each distinct expression once, against `Ui.Renderer`'s function set, and evaluates it on the closure backend. It binds the three host handlers itself, held to the catalog's conformance rows. It finds which roots an expression reads (does an address read `form`, does a tree read `result`) with the engine's tree query. No list of reads travels beside the expression.

**Paths stay paths.** A field that names a place keeps the accessor mode and its `{ root, path }` delivery, written `!path "row.id"`.
- **The query side of an option source:** its `value` property becomes the lookup filter.
- **A command's handler key.**
- **The queue's group key:** walked over the message body.

Where a server or browser decision reads a binding's root and path today, it reads `chain` off a delegated value whose expression is a plain member chain. Resource rules read it the same way (`UI_MUTATION_INPUT_UNSENT`). Those decisions are:
- a column's header, sort and relation
- an address input bound as exactly `input.<p>`, consumed into the URL
- a form whose `initialValues` reads `data`

Any other expression gives up what only a chain can give. Its column must write `header` (`UI_COLUMN_HEADER_REQUIRED`), it is not sortable or presented as a relation, and its input travels in the body. `x-telo-context-item-fills` cycles count every `values.<p>` an expression reads. Format-aware fit, `x-telo-value-schema-from` and the slot checks judge the expression's static type. A computed string is not a `date`.

**Conditions and enablement.** `visible` and each enablement `condition` are delegated booleans. A missing member is CEL's `no_such_key` unless guarded (`has()`, `.?`, `!= null`). An evaluation error in `visible` draws nothing. In an enablement rule it counts as failing, so the control fails closed. In a value it draws `value-error`. Each error goes to the console with its `expression` and `location`, and the page around it still renders. `Ui.Match` stays as the form-validation profile only.

**Migration.** There is none. The repo's manifests and tests are rewritten in the same change. An outside manifest writing `{ at, matches }` is refused as `SCHEMA_VIOLATION` at the field, and the changelog fragment shows the CEL form. `!cel` at a `!path` field gets the editor fix.

**Before / after.** Before, a sign-in banner needs `{ at, matches: { const: false } }`, and a two-cause archive button has one vague reason beside it. After, `visible: !cel "!data.signedIn"`. The archive button has two rules with their own messages, shown in a tooltip on the focusable button.

## Decisions

- **The mode is `delegated`.** It names what the kernel does: it hands evaluation to the evaluator the environment names. `browser` and `renderer` would put a host name in core vocabulary, `client` names one topology, `deferred` is what `runtime` already means, and `consumer` is Telo's word for an importer.
- **The environment is a module's declaration (`Telo.CelEnvironment`), not a per-function catalog flag.** The engine holds no host vocabulary. The fact belongs to the module owning the fields ("whoever renders `ui` supplies these"), and a third-party kind references `Ui.Renderer` with no change to `ui`.
- **The reused codes need no new ones.** "Nothing binds this function here" is already `FUNCTION_CALL_UNBOUND`, and a name out of scope at a mode is already `CEL_UNKNOWN_IDENTIFIER`.
- **Expressions cross the wire as source text.** It is CEL's own interchange, and any Telo engine in any language reads it. A tree as JSON would make the engine's private tree a cross-language contract. An emitted JS module runs only in JavaScript and puts generated code on the wire.
- **The browser engine is the running telo's.** A per-publish copy lets a manifest `telo check` accepted fail in the browser as `unbound_function` or a parse error. A version check could not see grammar or serializer changes.
- **The tag is `!path`.** "Path" is the word dotted key paths converge on (lodash, `FieldMask`, Kubernetes `fieldPath`, jq), and it is already the wire's `{ root, path }`. `!pointer` promises `/a/b` syntax.
- **The drawing key is `visible`, not `shown`.** Visible/Enabled is the pair independent UI toolkits converge on, including Qt, WinForms/WPF, Swing, VCL, Power Apps, Flutter and Compose. It has the same positive polarity, and hiding keeps the control's state. Telo's `desktop` windows already use `visible`. `show` collides with the `show` blocks on `Ui.Listing` and `Ui.Chat`, and `hidden` inverts the polarity.
- **Clock and random functions are refused.** A site re-evaluates only when the roots it reads change, so `now() > data.deadline` would look live and never update.
- **The hashes and `hmac` are refused for now.** The engine is synchronous and the browser's crypto is asynchronous. `joinPath` is refused always, because it is a server path.
- **Enablement is one rule or a list.** One sentence per cause has to stay a literal `Text` to be translatable, so a ternary over texts cannot pick it. One-or-many is the established form, and `ui` turns one rule into a list so nothing downstream sees two. This is the validation-rule pattern (Kubernetes `x-kubernetes-validations`, Zod `refine`) applied to enablement, not a UI convention; one rule reads like the usual flat pair. The keys are `condition` and `message`, Telo's rule words: `when` is `ui`'s server-side delivery gate, `reason` is a machine code elsewhere, and a `disabled` prefix is redundant under `enabled`.
- **The reason is a tooltip on a focusable `aria-disabled` control.** That is the established pattern, and the `disabled` attribute would hide the tooltip from keyboard and screen readers.
- **A failed value shows `value-error`, an inline, quiet marker.** It follows the spreadsheet `#VALUE!` pattern, translated for end users. The existing `error` part is a block alert with a developer code.

## Complete example after the change

```yaml
kind: Ui.Page
metadata: { name: reports }
path: /reports
title: Reports
children:
  - type: query
    query:
      kind: Ui.Query
      model: !ref Session
      url: /api/session
    content:
      - type: text
        text: Sign in to archive reports.
        visible: !cel "!data.signedIn"
  - kind: Ui.Listing
    presentation: !ref reportPresentation
    layout:
      kind: Ui.TableLayout
      columns:
        - !cel "row.title"
        - header: Tags
          value: !cel "size(row.tags) > 0 ? row.tags.join(', ') : '—'"
    rowActions:
      - mutation: !ref archiveReport
        label: Archive
        inputs: { id: !cel "row.id" }
        enabled:
          - condition: !cel "row.month != null"
            message: Choose a month first.
          - condition: !cel "!row.archived && size(row.tags) < variables.maxTags"
            message: { text: "Already archived by {$name}.", values: { name: !cel "row.archivedBy" } }
---
kind: Ui.Form
metadata: { name: inviteForm }
model: !ref Invite
fields:
  - email
  - kind: Ui.PickerField
    property: owner
    options: { kind: Ui.CollectionOptions, presentation: !ref people, value: !path "row.id" }
onSubmit:
  mutation: !ref sendInvite
  label: Send invite
  inputs: { email: !cel "values.email", owner: !cel "values.owner" }
  enabled: { condition: !cel "has(values.email) && size(values.email) >= 3", message: Enter an address first. }
```

## Verify

- `visible: !cel "sha256(data.x) != ''"` fails `telo check` with `FUNCTION_CALL_UNBOUND` naming `Ui.Renderer`, and `telo run` refuses before serving.
- Each of these at a delegated field has a `tests/check-run-agreement.yaml` row with `runFails:`:
  - `json(data) != ''` passes.
  - `now()`, `hmac(…)`, `joinPath(…)` and `Self.fn(…)` fail with `FUNCTION_CALL_UNBOUND`.
  - `secrets.x` and `resources.x` fail with `CEL_UNKNOWN_IDENTIFIER`.
- Deleting one name from `Ui.Renderer.hostBacked` turns every `ui` site calling it into a check error, with nothing else changed.
- A grep of `cel/`, `analyzer/`, `kernel/`, `sdk/` and `templating/` finds no module or host name.
- The served page's import map points `@telorun/cel` at the digest `ctx.resolveBuiltinBrowserEntry("@telorun/cel")` returns. The renderer bundle's metafile holds no `cel/` source. An expression using the newest catalog function evaluates under a `ui-react` published by an older telo.
- `!path "row.id"` delivers `{ root: row, path: [id] }`. `!path "row.id.upperAscii()"` is `ACCESSOR_NOT_PLAIN_CHAIN`. `!path` in a compile field is `PATH_OUTSIDE_ACCESSOR`. `!cel` at an option source's `value` is `ACCESSOR_NOT_PLAIN_CHAIN` with a `!path` fix.
- A union of one rule and a list on `enabled` registers without `EVAL_MODE_BRANCH_CONFLICT`. An empty list, a rule without `message`, or an empty `message` is `SCHEMA_VIOLATION`.
- `enablement.json` holds two cases:
  - Only the second rule fails: its message is shown. Both fail: the first is shown.
  - An erroring rule shows its own message.

  In both cases the button stays focusable with `aria-disabled="true"`, the reason in a tooltip, and nothing drawn beside it.
- A value reading a missing member renders `[data-telo-part="value-error"]` with the localized "Unavailable" and no `role="alert"`. The console logs the expression with its file, line and column, and the rest of the page renders.
- A column `!cel "row.a + row.b"` without `header` is `UI_COLUMN_HEADER_REQUIRED`. `!cel "row.title"` gets its header and sort as before.
- No manifest in the repo holds `shown:`, `matches:` under `visible` or `enabled`, `disabledText`, or `!cel` at an accessor field. `modules/ui/telo.yaml` and `modules/ui-react` hold no `shown:` key and no `#/$defs/Shown` reference.
- The `listing` and `chat` wire branches keep their own `show` blocks, and every schema registers with no duplicate key.

## Bookkeeping

- **Docs:**
  - `docs/extend/accessor-fields.md` (delegated fields, `Telo.CelEnvironment`, `!path`)
  - `docs/extend/browser-entries.md` (the third resolution)
  - `kernel/specs/builtin-vocabulary.md` (`browserEntries`)
  - `ui`'s `conditions.md`, `mutation.md`, `form.md`, `listing.md`, `nodes.md` and `texts.md`
  - `ui-react`'s parts and tooltip docs, and `queue`'s group key
- **Guides:** both `CLAUDE.md` files and `modules/CLAUDE.md`, the authoring-agent primer, and the hub's `build-ui` guide.
- **Ledger:** extend the ledger's screens-follow-their-data entry, since conditions are now full expressions checked before the app runs.
- **Templating:** register `!path` in both templating twins.
- **Translations:** add `valueUnavailable` to `ui`'s keys and its fourteen translations.
- **Theme:** style `value-error` in `UiReact.defaultTheme`.
- **Release:**
  - Ship the CLI `prepack` and the telo artifact's `browser` layer at publish.
  - Add a `ui-react` `restrictions:` floor for `ctx.resolveBuiltinBrowserEntry`, and run `telo release floor` for every module and example adopting the surface.
  - Add `Added` fragments, with the break described, on `analyzer`, `kernel`, `sdk`, `templating`, `cli`, `ui`, `ui-react`, `queue`, `queue-sql` and `crud-ui`.
