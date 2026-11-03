---
status: in-progress
priority: medium
depends-on: []
packages: [modules/ui, modules/ui-react, modules/i18n]
tracking: feat/data-driven-screens
---

# Data-driven screens and translation

A screen that is not one table's records — a sign-in gate, a context card, an
operation form whose inputs depend on each other, a result with warnings and per-row
follow-up actions — declared entirely in `ui`, and every text it shows, and every text
a backend sends, translated through one generic message core and one `i18n` module.
The proof is the NeuroSYS report console (today ~1 000 lines of hand-written HTML/JS
over an `Http.Api`), rebuilt as a `UiReact.App` with no feature lost.

## Shape of the solution

- **Messages are a closed profile of Unicode MessageFormat 2**, formatted by one
  zero-dependency core with pinned CLDR data, used identically by `telo check`, the
  kernels and the browser. Telo owns only the YAML spelling (the `Message`, `Text`
  and `TextCatalog` fragments) and a module's `lang:`.
- **The analyzer types inside node trees.** Context regions, eval paths and accessor
  sites are reached through recursive named shapes, nested regions add to their
  enclosing one, and browser-only bindings are refused in evaluated CEL. Nothing below
  can be checked without this.
- **Conditions read data through one JSON Schema profile.** A condition is
  `{ at, matches }`: it holds when the value `at` names validates against `matches`,
  written in the *interpreted profile* — one closed keyword set the renderer
  interprets for conditions and for live form validation alike, pinned by
  conformance rows `ui` ships. Delivery (`when`, evaluated on the server) and display
  (`shown`, a condition in the browser) are two keys.
- **Data on page load is `Ui.Data`** over a new record contract; a sign-in gate is
  `Ui.Data` plus a condition plus `reloadOn: [unauthorized]`, not a kind of its own.
- **An action draws its answer as a node tree** (`result:` / `failure:`), with two
  new nodes, `value` and `list`; one `Ui.RowAction` shape serves tables and lists,
  and a row draws the pressed action's own answer in place of its button.
- **Form fields are kinds** under a `Ui.Field` abstract that declares only what
  every field has; each field kind judges its own fit to the model, so a field kind
  from another module is checked with no change to `ui`. Options come from an
  option-source abstract; kept state is one record shared with the filter bar.
- **Translation is generic.** `i18n` (`I18n.Catalog`, `I18n.Translator`,
  `I18n.Negotiator`) is used by backends from CEL and by `ui-react` on the server.
  The browser receives every text as a translated, parsed message and formats it with
  the same core — never a catalog.

This reverses three established `ui` rules, all recorded in the modules guide and
updated with it: "there is no per-field `control` key" (fields become kinds and share
one `Ui.Control` vocabulary with the filter bar), "what an action draws is its own
ordered `lists`, not a node tree" (`lists` is removed), and "`kind:` is the only
discriminator an author writes", which is narrowed to resources and slot values —
`type`-tagged nodes in a tree are the stated exception.

**Packages and dependency direction.**

- `@telorun/message-format` (`message-format/nodejs/`) and its Rust twin
  `telorun-message-format` (`message-format/rust/`), laid out as `cel/` is: MIT,
  zero dependencies, on the telo version line (a member of the changesets `fixed`
  group; the crate carries the same version). The analyzer checks messages with it;
  `@telorun/sdk` depends on it and re-exports it, so controllers share one realm (the
  SDK's second runtime dependency); `ui-react`'s renderer browser entry inlines it.
- `ui-react` → `ui`, `i18n`; `ui` imports no `i18n` — it uses only the built-in
  fragments and formats. `i18n` imports nothing from `ui`. `i18n` is MIT, with
  `license: MIT` and its own `LICENSE`. `message-format/` joins the MIT directory
  list in `pnpm run check:licenses` and the root `README.md`.

**Relation to the chat plan** (`2026-10-18-chat.md` beside this one): both add node
types to `Ui.SpecNode` (`chat` there; `value`, `list` here) and parts to the
styling contract; neither depends on the other.

---

## Phase 1 — The `i18n` module

**Before.** A backend writes language-specific text inline; there is no way to send
an email or an API error in the caller's language.

**After.**

- `I18n.Catalog` (Provider): its schema is the `TextCatalog` fragment. Every value
  is a literal (`MESSAGE_ENTRY_COMPUTED`). Entries are parsed and indexed when the
  resource is created.
- `I18n.Translator` (native `Telo.Callable`, `deterministic: true`): `catalogs:
  [!ref …]`, declared as an instance in the module that owns the texts and called
  from CEL as `Self.<name>(text, lang, values?)` → string.
  - `text` is a `Text` parameter: a literal source text or `{ text, context }`.
  - `lang` is one resolved tag, passed on every call — there is no ambient locale.
    Lookup is RFC 4647 truncation.
  - `values` maps placeholder names to values.
  - One (text, context) pair translated twice within a language across its catalogs
    is `MESSAGE_ENTRY_DUPLICATE`, a resource rule reading the catalogs through
    `resolve:`, twinned at creation.
  - A dynamic choice (an error code to a message) is a CEL map of literal calls; the
    documented examples guard a missing code with `.?` / `orValue`.
- `I18n.Negotiator` (native `Telo.Callable`): `{ translator: !ref …, default:
  <language-tag> }`, `default` being the language the texts are written in. Called
  with an `Accept-Language`-style string, it returns the best tag by RFC 4647 lookup
  with q-values over the translator's catalog tags **plus `default`**.
- Formatting is the core's. `i18n` exports the `exports.code` specifier
  `@telorun/i18n` only for reading a translator's catalog set, which `ui-react`'s
  controller uses. `i18n` has no Rust controllers until the Rust kernel hosts CEL;
  the core's Rust twin is tested against the vectors now.
- An API answers in the caller's language by negotiating once per request, passing
  the tag to every translation, and writing it to `Content-Language`.

**Verify.**

- An application with a Polish catalog: `Self.t('Rate not found for {$user}', 'pl',
  { user: 'Ala' })` and a plural message at counts 1, 3, 5 equal the expected texts
  (`Assert.Equals`); `pl-PL` falls back to `pl`, `de` to the source; an untranslated
  Polish source formatted for `de` selects with Polish rules.
- `Self.language('de;q=0.9, pl;q=0.8')` with `pl` and `en` catalogs returns `pl`;
  `en;q=1, pl;q=0.5` with only a `pl` catalog and `default: en` returns `en`.
- Two entries with the same text and different `context` translate independently;
  a duplicate pair is `MESSAGE_ENTRY_DUPLICATE`, also across two catalogs of one
  translator.
- Renaming a shape's `title` makes the catalog key that held it `MESSAGE_TEXT_UNUSED`
  at the catalog entry; analysis of a 10 000-entry catalog stays linear.
- `modules/i18n/docs/` and its README exist; the hub search text describes
  translation, plurals and language negotiation.

---

## Phase 2 — Conditions, `Ui.Data` and the record contract

**Before.** Only `Ui.Table` loads data, and only through the collection contract.
A node's `when` is a CEL boolean the server evaluates per request over
`request.headers` / `request.ip`; nothing can show or hide content by data.

**After.**

Shapes in `ui`:

- `Ui.Match` — the interpreted profile, closed: `type`, `const`, `enum`, `not`,
  `allOf`, `anyOf`, `required`, `properties`, `items`, `minItems`, `maxItems`,
  `uniqueItems`, `minLength`, `maxLength`, `pattern` (an `re2-pattern`), `minimum`,
  `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`. Any other keyword
  is a `SCHEMA_VIOLATION`. Its meaning is pinned by conformance rows shipped as data
  in `ui`, which `ui-react`'s tests read.
- `Ui.Condition` — `{ at, matches }`, `matches` carrying `x-telo-match-for: "/at"`.
  `at` is a plain chain rooted at a binding of the enclosing scope
  (`ACCESSOR_NOT_PLAIN_CHAIN`, `CEL_UNKNOWN_FIELD`). A missing value never satisfies
  a condition, even under `not`; `null` is a present value; absence is tested at the
  parent with `not: { required: [<name>] }`. A condition that cannot hold for the
  type at `at` is `MATCH_UNSATISFIABLE`.
- `Ui.Enablement` — `{ at, matches, disabledText }`, a condition plus the required
  reason shown while it does not hold.
- `Ui.RequestError` — `{ status?, code?, message? }`, `status` absent when nothing
  answered.
- `Ui.QueryParameters` — a named shape declaring page query parameters, each a
  string schema or a list of strings for a repeated key; a name beginning `_telo` is
  refused by the shape.

Node and control keys:

- `when` keeps its Telo-wide meaning: an evaluated boolean deciding whether a node is
  **delivered** — per request on a page's own nodes, at creation inside a composite.
  Content whose `when` is false is not sent and has no state.
- `shown` holds a `Ui.Condition` deciding whether a delivered node is **drawn**. Both
  keys may be present. `Ui.SpecNode` carries `shown` and never `when`.
- `enabled` holds a `Ui.Enablement`, on a `Ui.Action` (its button, over its own
  `values`) and on a `Ui.RowAction` — never on a node. Hiding and disabling are
  inverted with `not`.
- Content with `shown` false keeps its state and starts no request. A hidden field's
  own value is neither sent nor checked, but the record is still validated against
  the model: a property the model requires whose field is hidden blocks submission,
  the finding shown under the form. A reload trigger that arrives while a reader is
  hidden is remembered and read once when it is shown; a request already in flight
  completes into the kept state.

Binding roots, all `x-telo-context-accessor-only`. Scope is one resource's own
declaration: a composite placed by `!ref` (or inline, which is extracted into its own
resource) sees only the roots its own kind binds.

| Root | Where |
| --- | --- |
| `data` | inside a `Ui.Data`'s `content` |
| `result`, `input`, `values` | an action's `result:` |
| `error`, `input`, `values` | an action's `failure:` |
| `error` | a `Ui.Data`'s `failure` |
| `values` | a field's or group's `shown`, an option source's `filters`, an action's `enabled` |
| `row` | a list or table row |
| `query` | wherever the resource or page declares `query:` (a `Ui.QueryParameters`); with none declared the root is closed and empty |

When an action runs from a row, `values` in its trees is the record the press sent
(equal to `input`).

The **record contract** (`modules/ui/docs/record-contract.md`): `GET <path>` with
the declared params as query parameters, answered by a 2xx JSON object valid
against the reader's `model`; 401 and 403 to a request inside the content are shown
where they happened; anything else is a failure, its `{ code, message }` body read
into `Ui.RequestError`.

`Ui.Data` (extends `Ui.Composite`, wire node `data`): `model`, `query?`, `source: {
path, params? }` (each param a plain chain over the reader's own declaration's
roots, its declared `query` included, a scalar sent as a query parameter), `content`,
`loading?`, `failure?` (with `error` bound), and `reloadOn: [focus | unauthorized]`.

- `focus` reloads on window focus and on a back/forward-cache restore.
- `unauthorized` reloads when a request made by anything drawn inside its `content`
  answers 401 — following the rendered tree across composite placements and never
  counting its own GET, so it cannot loop. A 401 or 403 to its own GET draws its
  `failure` tree.
- A reader also reloads when an action's `onSuccess.refreshes` names its path — the
  same path-keyed invalidation tables use.
- At most one GET is in flight per reader; any number of triggers during it cause
  exactly one more read after it; an answer older than the latest is never drawn.
- `loading` is drawn only before the first answer; a reload keeps the previous
  content mounted.
- `ui` fills the defaults for `loading` and `failure`.

Two new nodes in `Ui.Node` / `Ui.SpecNode`, usable in any data scope, each carrying
`present` resolved on the server as list columns are today:

- `value` — one accessor, presented as its schema says; a `format: uri` /
  `uri-reference` value is a link (under the existing address rule), with an
  optional literal `text`.
- `list` — `rows` (an accessor), `columns: [{ header?, value, shown? }]` (a column's
  `shown` reads the scope's roots, never `row`), `heading?`, `rowActions`
  (`Ui.RowAction`). A list draws a member of one answer and is bounded by
  it; it never pages — a set that grows without limit is served by the collection
  contract and drawn by `Ui.Table`.

**Verify.**

- `telo check` reports `SCHEMA_VIOLATION` for `if` in `matches` and for a
  `_telo`-prefixed query parameter, `MATCH_UNSATISFIABLE` for `const: billing` at an
  integer, `CEL_UNKNOWN_FIELD` for `data.x` outside a `Ui.Data`, for `values.x`
  outside a form and for `query.signn` where only `signin` is declared, and
  `CEL_UNKNOWN_IDENTIFIER` for `!cel "data.x"`; each `UI_*` rule has its `ERR_` twin
  at creation, pinned in `modules/ui/tests`.
- A page document (`<mount>/_telo/ui/page?path=…`) with a `Ui.Data` returns a
  `data` node with its source, `shown` objects unchanged, no `when` key, and filled
  defaults (`Assert.Equals`).
- `ui-react` unit tests: a 401 inside the content reloads the reader and draws the
  branch its condition selects; hidden content keeps typed values; a hidden required
  field blocks submission; a trigger while hidden is read on show; a burst of 401s
  causes one more GET; a stale answer is not drawn; a reload keeps content mounted;
  every row of `ui`'s profile conformance file passes, the missing-value cases
  included.

---

## Phase 3 — Field kinds, option sources, the date range, state, live validation

**Before.** A form's fields are `{ property }` entries whose control the model
alone decides; no option list comes from a server; values are lost on reload;
fields are validated only by the server's 400.

**After.**

Fields (`fields` on `Ui.Form` and `Ui.Action` stays one flat ordered list; `fields`,
`groups` and `state` are the same named shapes on both):

- `Ui.Field` (abstract): `property` (required), `group?`, `shown?` (a
  `Ui.Condition` over `values`). Every field kind enters exactly one property.
- `Ui.Control` — one named shape, `auto | select | options | toggle | slider |
  tags`, typing `Ui.InputField.control`, `Ui.ChoiceField.control` and
  `Ui.Filters.fields[].control` (the bar adds its own `none`). One fit predicate
  judges it, over whether the value is one value or a list (for a filter set by `in`,
  for a field by `type: array`) and the property's types. `auto` means the host's own
  derivation table; what `toggle`'s off state holds is the host's — nothing for a
  filter, `false` for a field.
- `Ui.InputField`: `property`, `control`.
- `Ui.ChoiceField`: `property`, `options` (a `Ui.OptionSource`), `control`; the fit
  refuses `toggle` / `slider` / `tags`, and its `auto` means `select`.
- `Ui.PickerField`: `property`, `options`, `surface?` (a `Ui.Overlay`; `ui` fills a
  dialog).
- `Ui.DateRangeField`: below.
- A bare property name is exactly `{ kind: Ui.InputField, property: <name> }`, and
  the page document is identical for both spellings.
- **A field kind judges its own fit.** Each field kind's fit to the model is a
  referrer rule on `Self.Form` and on `Self.Action`, reading the owner's model
  through `resolve:`. Its runtime twin is a field contract in
  `@telorun/ui`: each field judges itself against the model property its owner hands
  it, and the owner raises `ERR_<code>` without naming any field kind. Owner rules
  read only `property`, `group` and `shown`; a bare name is judged by the existing
  enterable check, pinned equal to `Ui.InputField`'s `auto` fit by a unit test.
- `groups: [{ name, label, description?, shown? }]` declares labelled sections. A
  group's fields are contiguous in `fields`, so list order is draw order.
- The model still decides validation, the label (`title`), the hint
  (`description`) and the initial value (`default`). The one exception is an initial
  value relative to the viewer's clock, which a model cannot express: the date
  range's `initialPreset`.

Codes:

| Code | Declared on | When |
| --- | --- | --- |
| `UI_FIELD_UNKNOWN_PROPERTY` | `Ui.Form`, `Ui.Action` | a field's property is not in the model |
| `UI_FIELD_UNSUPPORTED` | `Ui.Form`, `Ui.Action` | a bare name no control can enter |
| `UI_FIELD_REQUIRED_NOT_ENTERED` | `Ui.Form`, `Ui.Action` | a required property no field enters |
| `UI_FIELD_DUPLICATE` | `Ui.Form`, `Ui.Action` | one property entered twice |
| `UI_FIELD_GROUP_UNKNOWN` | `Ui.Form`, `Ui.Action` | a field names an undeclared group |
| `UI_FIELD_GROUP_SPLIT` | `Ui.Form`, `Ui.Action` | a group's fields are not contiguous |
| `UI_FIELD_GROUP_DUPLICATE` | `Ui.Form`, `Ui.Action` | two groups share a name |
| `UI_STATE_FIELD_UNKNOWN` | `Ui.Form`, `Ui.Action`, `Ui.Filters` | `state.fields` names a property the component does not show |
| `UI_FIELD_CONTROL_UNSUPPORTED` | input and choice fields | the control does not fit the property |
| `UI_FIELD_OPTION_VALUE_MISMATCH` | choice and picker fields | the source's `value` type is not the property's (or its items') |
| `UI_DATE_RANGE_PROPERTY_INVALID` | date range | the property is not an object of exactly `from` / `to`, each `format: date` |
| `UI_DATE_RANGE_DEFAULT_CONFLICT` | date range | `initialPreset` beside a model `default` on the property |
| `UI_DATE_RANGE_PRESET_UNKNOWN` | date range | `initialPreset` names no declared preset |
| `UI_DATE_RANGE_PRESET_LABEL_DUPLICATE` | date range | two presets share a label |
| `UI_OPTION_SEARCH_NOT_ACCEPTED` | collection options | `search` is not a filter pair the collection declares |
| `UI_OPTION_VALUE_NOT_FILTERABLE` | collection options | `value` is not a one-step chain over `row` to a property the collection declares with `in` |
| `UI_OPTION_FILTER_CYCLE` | collection options | a source's filters read its own field's property, or sources read each other in a cycle |

Each has its `ERR_` twin. They replace `UI_FORM_FIELD_*` and `UI_ACTION_FIELD_*`.

Option sources:

- `Ui.OptionSource` (abstract; a provider whose page-document shape is
  `Ui.OptionSourceSpec`, tagged by `type`): `model`, `value`, `label`, `hint?`,
  `href?` — accessors over `row`, typed from `model`.
- `Ui.CollectionOptions`, the first source kind: `collection`, `source: { basePath,
  filters? }`, `search?: { property, operator }`.
  - Options are read through the collection contract, paged by `next` as the list
    scrolls, at most one page per scroll.
  - A search is sent after `ui`'s typing pause (the one `apply: typing` uses); Enter
    sends at once; an answer to an older search is discarded.
  - A chosen value with no label in hand — an edit prefill, a model default, a
    stored value, a re-read — is labelled by one request filtering `value` with
    `in`; a value the request does not return is dropped. Labels are never stored.
  - The chosen value is drawn as its `label`, linked by `href` when declared.
- `source.filters` values (on `Ui.CollectionOptions` and on `Ui.Table`) may be
  accessors — a plain chain or a literal — over the enclosing roots, `values`
  included, each typed against its model property and an `eq` pair the collection
  declares. While any value a source reads is absent, it sends no request and offers
  nothing. When one changes, the source re-reads from its first page and the chosen
  values are held to it through the `in` lookup under the new filters: values still
  offered are kept, the rest dropped.

`Ui.DateRangeField`: `property`, `presets: [{ label, unit: day | week | month |
quarter | year, offset }]`, `weekStart: monday | sunday` (`ui` fills `monday`),
`initialPreset?`, `warnLongerThan?: { unit, count }`.

- The property is one object of `from` and `to`, each `type: string, format: date`.
- Presets and `initialPreset` are computed in the browser's time zone, at load and
  at click; a preset is shown active whenever the dates equal it, chosen or typed.
- From after to blocks submission; a range longer than `warnLongerThan` shows a
  warning and does not block. Both texts are `ui`'s words.

Kept state:

- `Ui.StateRecord` is `{ key, address, store, fields? }`, at least one of `address`
  and `store` written, used unchanged by `Ui.Filters.policy.state`, `Ui.Form.state`
  and `Ui.Action.state`. `fields` lists the properties kept; omitted, every property
  the component shows is kept. A property the model marks `writeOnly: true` is never
  kept. Only values are stored.
- A form starts from the record it edits, else the address, else the store, else
  the model's defaults and `initialPreset`.
- Values read back are held to the interpreted profile, to the current fields and to
  their option source; storage the browser refuses falls back to memory.
- The renderer spells form and action state apart from a bar's, so a bar and a form
  sharing a `key` never read each other's entries.

Live validation:

- The renderer validates entered values against the model's keywords that fall in
  the interpreted profile, showing a field's errors once it has been touched.
  Keywords outside the profile — a `pattern` outside `re2-pattern` included — stay
  legal in models and are left to the API.
- A hidden required property blocks submission as Phase 2 states.
- A server 400's detail lands on the field whose property is the first segment of
  the detail's `path` (`period.from` reaches the range field); one for a property no
  shown field enters is shown under the form.

`Crud.Ui` and every in-repo manifest writing `fields: [{ property }]` are rewritten
by hand to property names or field kinds.

**Verify.**

- `telo check` reports every code in the table above at the line that wrote it,
  each with its `ERR_` twin, pinned in `modules/ui/tests`.
- A fixture field kind declared in another module, extending `Ui.Field`, is accepted
  in `fields` and judged by its own rule, with no change to `ui`; no `Ui.Form` /
  `Ui.Action` rule reads `control`, `options` or `presets`.
- `fields: [title]` and `fields: [{ kind: Ui.InputField, property: title }]` produce
  identical page documents; the page document carries each field kind's
  `type`-tagged spec with defaults filled, `groups`, the option source and `state`
  (`Assert.Equals`).
- An edit form over a record holding three ids sends one `…?<value>.in=` request and
  shows three labels.
- `ui-react` unit tests: a picker never requests more than one page per scroll; a
  stale search answer is discarded; a source with an absent filter value sends
  nothing; changing a field a source reads keeps the chosen values it still offers;
  presets at week, month and year boundaries for both `weekStart` values; a kept
  value survives a reload; `minLength` is reported before submission and replaced by
  the server's detail on the same field; a `period.from` detail reaches the range
  field.
- `Crud.Ui` tests and the todo starter pass unchanged in behaviour.

---

## Phase 4 — Translated screens

**Before.** `UiReact.App.lang` is a literal; every label is the shape's `title` and
every renderer word is English.

**After.**

- `UiReact.App.translator: !ref <I18n.Translator>` (optional). Lookup is the
  translator's chain; a text with no entry shows its source.
- `UiReact.App.lang` is evaluated per request with `request.headers`, as a theme's
  `when` is (`!cel "Self.language(request.headers['accept-language'])"`, guarded with
  `in`). The application and page documents, their `lang` and the shell's
  `<html lang>` use the effective tag the lookup lands on — a catalog's tag, else the
  App module's `lang:` — so the document cache holds at most one entry per catalog
  language plus one.
- `Vary` names exactly the headers the per-request expressions read (`lang`, theme
  `when`, page nodes' `when`), taken from their parsed reads; a computed header name
  gives `Vary: *`.
- The controller translates every text of the spec on the server: `Text` fields,
  shape titles and descriptions, and enum labels — sent as a label map beside the
  schema, never by rewriting enum values. An enum label's source is the `title` of
  the value's `const` branch when the shape has one, else the value; its context
  comes from `x-telo-text-context`.
- Every text crosses in one wire form: its translated Message, already parsed. The
  browser formats it with the core — plural choice, placeholders and number
  formatting.
- In a data scope a node's text field may be a `Ui.BoundText` — `{ text, values }`,
  `text` a `Text` and `values` mapping each placeholder to an accessor over the
  scope's roots — so a heading over an answer ("3 nieopłacone pozycje") is composed
  in the page, not by the backend. A placeholder `values` does not bind is
  `MESSAGE_PLACEHOLDER_UNBOUND`.
- `ui` declares `lang: en` and its own words (loading, cancel, nothing found, no
  rows, pending, failure, each profile keyword's validation message with its
  placeholders, the date-range words) as ordinary `Text` values, each with an id,
  sent translated and keyed by word id.
- `ui`'s displayed-text fields (labels, headings, `text`, `disabledText`, a group's
  `label`, a preset's `label`, …) are typed `Text`, or `Ui.BoundText` where they sit
  in a data scope.

**Verify.**

- A page fetched with `Accept-Language: pl` and with `en` returns different `lang`
  and labels and different ETags; `pl-PL` with only a `pl` catalog returns Polish
  labels and `lang: pl`.
- A `lang` that reads `cookie` gives `Vary: Cookie`; 1 000 distinct header values
  leave at most catalogs + 1 cache entries.
- An enum label is translated and the enum value sent back is unchanged.
- A `ui-react` unit test fills "co najmniej {$limit} znaków" at 3 and 5, and an
  author heading's plural over `result` in `pl`, with no catalog present in the
  browser; the browser vectors pass.
- A catalog entry for a renamed label warns `MESSAGE_TEXT_UNUSED`.

---

## Phase 5 — The proof: `examples/report-console`

**Before.** No example uses a data-driven screen.

**After.** `examples/report-console/` — an application over stub `Http.Api` routes
answering fixture data (no Google, no YouTrack), using every primitive above, with
Polish catalogs. Its `tests/` start it with `App.Instance` and assert the
application and page documents and every route the screen calls.

**Verify.** `examples/test-suite.yaml` passes; the page documents contain every
node and field kind in the checklist below.

---

## Phase 6 — The invoicing console rebuilt

**Before.** `apps/report-console/public/index.html` in the invoicing repository is
the whole frontend, served by `Http.Static`.

**After.** The page is a `UiReact.App` mounted at `/`, importing the released
`ui`, `ui-react` and `i18n`; `public/` is removed. Backend adjustments, each
preserving the feature:

- `/api/generate` takes `period: { from, to }` and derives the period string and
  the report kind (from the chosen columns) itself.
- `/api/drive/files` and `/api/projects` speak the collection contract, declaring
  their value property with `in` and the spreadsheet filter with `eq`; a Drive file
  row carries its URL.
- `/api/draft` answers the Gmail draft URL; `/api/upload` answers its link and
  target folder text.
- `/api/auth` reports the last sign-in failure reason, read by `Ui.Data`, alongside
  the `?signin=` query parameter declared on the page.
- Composed headings and Polish plurals (skipped projects, "N projektów z
  zalogowanym czasem") are `Ui.BoundText` over the answer, or come from
  `I18n.Translator` on the server.

Feature checklist (every row must be reachable in the rebuilt page):

| Console feature | Primitive |
| --- | --- |
| Wait for the auth check; banner replaces the form | `Ui.Data` over `/api/auth`, `shown` on `data.authorized` |
| Any 401 shows the banner, keeping values and results | `reloadOn: [unauthorized]`; hidden content keeps state |
| Re-check on focus / back-forward restore | `reloadOn: [focus]` |
| Connect → Google consent URL | action with `onSuccess.navigate: result.url` |
| Sign-in failure reason | declared `query.signin` and `data` from `/api/auth`, `shown` per reason |
| Sign out, then re-check | action with `onSuccess.refreshes: [/api/auth]` |
| Account email | `Ui.Data` over `/api/auth/user`, `value` node |
| Sheet / folder chooser with debounced search, rows with hints, states | `Ui.PickerField` over `Ui.CollectionOptions` on the Drive collection, `search`, overlay surface |
| Chosen sheet / folder remembered, shown as a link | `state: { store: Ui.LocalStore, fields: […] }`; label re-read by the `in` lookup; `href` |
| Rest of the form hidden until a sheet is chosen | group `shown` over `values` |
| Changing the sheet reloads projects and clears results | option-source filter over `values.spreadsheetId`; `clearAnswerOn` |
| Period presets, from/to, active preset, from > to refused | `Ui.DateRangeField` over `period`, `weekStart: monday`, `initialPreset` |
| More-than-one-month warning | `warnLongerThan: { unit: month, count: 1 }` |
| Projects with email hint; none = all | `Ui.ChoiceField` (`control: options`) over `Ui.CollectionOptions`, `hint` |
| Columns in fixed order with defaults | `Ui.InputField` over an enum list with model `default` |
| Hours format radio, merge, chart toggles with hints | `Ui.InputField` (`options`, `toggle`), `description` |
| Fieldset sections with legends | `groups` |
| Generate, pending, previous results cleared | `Ui.Action`, `clearAnswerOn`, renderer pending state |
| Unpriced / unassigned / no-currency boxes only when non-empty | `shown` with `minItems: 1`, `list` nodes, `danger` style |
| Results table, amount column only for billing | `list`, column `shown` on `result.kind` |
| PDF link | `value` / column over a `uri-reference` |
| Draft button, disabled without email; link on success | row action, `enabled` with `disabledText`, its `result:` in place |
| Upload button, needs folder at click time, serialized | row action reading `values.folder`, `concurrency: serial` |
| Upload uses the generated period | row action reading `input.period.from` / `input.period.to` |
| Empty-state variants | `shown` over `result.files` / `result.projectsInPeriod` |
| Failure box "HTTP status · code" + message | `failure:` over `error` |
| Composed headings with Polish plurals | `Ui.BoundText` over `result` |
| Polish UI including renderer words | `I18n.Catalog`, `I18n.Translator`, `UiReact.App.translator`, `lang` |
| Light theme, dark-blue table header | `Ui.Theme` plus a stylesheet over `data-telo-part` |

**Verify.** Every checklist row is exercised by hand against the stub-free
application, and the invoicing repository's manifest tests pass.

---

## Documentation and sync (each phase, in the same change)

- Module docs and READMEs: `ui` (conditions and the profile, `when` / `shown`,
  data, record contract, action contract failure body, row actions, fields, option
  sources, date range, state, nodes, bound text), `ui-react` (translation, `lang`,
  `Vary`, styling parts for the new nodes and fields), `i18n`, `crud` (field
  shorthand).
- The built-in vocabulary spec and the analyzer guide: the two message formats, the
  three fragments, `x-telo-text-context`, the module `lang:` key, the typing
  annotations, `re2-pattern` and referrer-rule `resolve:`;
  `docs/extend/referrer-rules.md`.
- Root `CLAUDE.md`: the annotation list, the shared fragments, the module keys, the
  SDK's dependency rule (now `@telorun/cel` and `@telorun/message-format`), the
  monorepo structure and telo version line (`@telorun/message-format`), and the MIT
  directory list.
- `modules/CLAUDE.md`'s Declarative UI paragraph: field kinds and `Ui.Control`
  replace "no per-field control key", `result:` replaces `lists`,
  `UI_ROW_ACTION_DRAWS_LISTS` removed, `kind:` as the only discriminator narrowed to
  resources and slot values with nodes as the exception, `when` / `shown`,
  conditions and the interpreted profile, `Ui.Data`, `Ui.RowAction`,
  `Ui.StateRecord`.
- `metadata.description` on `i18n` and every new kind, written as hub search text.
- The hub guide `build-ui` (data, conditions, fields, translation) and the
  authoring-agent primer.
- A `telo release add` fragment (`Added`, stating each break) for `ui`, `ui-react`,
  `i18n`, `crud` and every starter rewritten; a changeset for the telo version line
  (the new core, the SDK, the analyzer and every member the format, fragments and
  annotations touch).
