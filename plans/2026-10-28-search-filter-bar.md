# Search box with filter tokens

## Goal

A filter bar can be drawn as one search box. The viewer types, and the box offers what the text could mean: search everywhere, or one filter per field that accepts text ("Name: backen", "Client ID: backen"). Picking one turns it into a chip. Field names can be typed too (`status:draft,published`, `createdAt>=2026-01-01`), and a field picked from the list opens its value picker: an enum's values or a relation's records, labelled by name.

Every chip is a filter the collection already declares, joined to the others by AND. The one OR is a search across several properties, which the collection declares itself. The viewer writes no OR, parentheses or negation, so `telo check` still judges every request a screen can send.

This ships after the related-records plan and is written against what it leaves behind: `DataModel.Collection`, `Ui.CollectionPresentation`, relation value lists, `values: present`, `Ui.Listing`.

## 1. `data-model`: declared search

`DataModel.Collection` gains `query.search`: `{ properties }`, a list of string properties. One text then matches a record when any of them contains it, case-insensitively.

- Wire: `search=<text>`, combined with the other filters by AND. A facet request carries it like any other active filter.
- `search` joins the reserved query names: `limit`, `cursor`, `sort`, `facet`, `search`, and anything starting with `_telo`. A filter on a property called `search` is now `DATA_MODEL_FILTER_RESERVED_NAME`.
- Without `query.search`, a request carrying `search` is refused as an undeclared filter is.

**Rules**, each a resource rule with an `ERR_` twin:

| Code | When |
| --- | --- |
| `DATA_MODEL_SEARCH_UNKNOWN_PROPERTY` | a search property is not declared by `model` |
| `DATA_MODEL_SEARCH_UNSUPPORTED` | a search property is not a string (`null` aside) |
| `DATA_MODEL_SEARCH_EMPTY` | `query.search.properties` is empty |

**Docs:** `modules/data-model/docs/collection.md` and `collection-contract.md` (the key, `search=`, the reserved name).

**Verify:**
- Every rule is pinned both ways in `modules/data-model/tests/`.
- No in-repo collection filters a property called `search`.

## 2. `crud`: answering a search

`Crud.Api` answers `search=<text>` with the same match it uses for `contains`, on each declared property's column, OR-ed together and AND-ed with the other filters. `ERR_CRUD_QUERY_INVALID` refuses `search` on a collection that declares none. A facet request answers under the search too.

**Docs:** `list-route.md`.

**Verify:** `GET /api/posts?search=back&status=draft` answers the drafts whose title or body contains "back", in either case; the same request against a collection with no `query.search` is `ERR_CRUD_QUERY_INVALID`.

## 3. `ui`: the search field

A filter bar field may be `{ operator: search }`, with no `property`. It holds one string and sends it as `search`.

- It is legal only when the collection declares `query.search`; otherwise `UI_FILTER_SEARCH_UNDECLARED`.
- With `fields` left out, a collection declaring `query.search` gives the bar this field first, then the filters, as today.
- It takes `pinned`, `default` (a string) and `control` (`auto` or `none`); a preset names it as `{ operator: search, value }`; the bar's state keeps it under `search`.
- In the other placements it is drawn as a typed box labelled with the word `search`.
- `UI_FILTER_DUPLICATE` covers two search fields. `Ui.controlFits` maps `search` to a typed box.

## 4. `ui`: `Ui.SearchPlacement`

A new filter placement, extending `Ui.FilterPlacement`: the bar's controls sit in one search input above the content. Its one key is `placeholder`, a `Text`, defaulting to the word `searchAndFilter`. It does not fold, so it has no `compact` and is not a `Ui.FoldingFilterPlacement`.

**What the box shows**
- Each filter holding a value is a chip in the input, naming its field's title and its value ("Application type: Single Page Application"). Removing a chip clears that filter, as removing one under `show: chosen` does.
- A filter with `control: none` is never a chip, as it is never drawn today.

**Suggestions**, a list under the input, in sections:
- **Empty input:** the presets, then the bar's fields by title. Picking a field starts a token for it.
- **Typed text with no field prefix:**
  - "Search: \<text\>" first, when the bar has a search field;
  - then one entry per field the text can be a value for, in the bar's order: `contains`, and `eq` / `in` on a string with no `enum` and no relation;
  - then the fields whose title or property name starts with the text.
- **After a field prefix:** that field's values. An enum's values and labels, or a boolean's two. A relation's records, read through the relation's `search` and drawn with its `label` and `hint`. Typed text, for a field taking it. Under `values: present`, only the values that occur, with counts. Under `in`, choices are checkboxes and several can be picked.

Enter takes the highlighted suggestion; the first one starts highlighted. Arrow keys move, Escape closes the list. Backspace in an empty input turns the last chip back into editable text.

**Typed tokens.** A token is `<property><operator><value>`:
- `:` picks the field's `contains`, else its `in`, else its `eq`;
- `=` picks `in`, else `eq`;
- `>`, `>=`, `<` and `<=` pick `gt`, `gte`, `lt` and `lte`.

The property is the field's property name, matched case-insensitively. The value is read as the bar's address spells that filter's value: commas separate `in` values, and double quotes enclose a value holding spaces, commas or quotes (`\"` inside). An enum value also matches by its label; a relation value by its key, or, through the relation's `search`, by the one record whose label matches exactly.

A token naming no filter the bar shows, or with a value its filter refuses, stays as text, marked invalid with the reason, and sends nothing. Committing a valid token makes it a chip; its value then applies as the bar's `apply` says.

**Policy under this placement**
- `show`, `controls` and `summary` have no effect: a filter is in the box exactly when it holds a value. Writing any of them on a bar placed here is the warning `UI_FILTER_POLICY_UNUSED`.
- `pinned` has no effect, since nothing folds: `UI_FILTER_PINNED_UNUSED` is reported for this placement as for an `Ui.AbovePlacement` with no `compact`.
- `apply`, `state`, presets, defaults and Reset behave as in every placement. Under `apply: button`, committed chips wait for the Apply button beside the box.
- The bar's state, its address spelling and its store are unchanged, so a link to a filtered page is the same whichever placement draws the bar.

**Wire:** `Ui.FilterPlacementSpec` gains the branch `search` `{ placeholder }`; a filter field's spec takes `operator: search` with no `property`.

**Words:** `search` and `searchAndFilter` join the English `Ui.words` set.

**Rules**, each with an `ERR_` twin where it is an error:

| Code | Kind | When |
| --- | --- | --- |
| `UI_FILTER_SEARCH_UNDECLARED` | `Ui.Filters` | a `{ operator: search }` field on a collection with no `query.search` |
| `UI_FILTER_POLICY_UNUSED` (warning) | `Ui.SearchPlacement`, referrer rule | the bar writes `show`, `controls` or `summary` |
| `UI_FILTER_PINNED_UNUSED` (warning, extended) | `Ui.SearchPlacement`, referrer rule | a field is `pinned` |

**Conformance:** new `modules/ui/conformance/search-tokens.json`, shipped through `files:`, pinning how text becomes bar values:
- each operator spelling;
- quoted and comma-separated values;
- enum labels;
- the field a bare `:` picks when a property has several filters;
- a property name typed in another case;
- each invalid token and its reason.

**Docs:**
- `filter-placement.md`: the placement, the suggestions, the tokens, the policy.
- `filters.md`: the search field and the new rules.

**Verify:**
- On the posts listing with `query.search` over `title` and `body`, typing "back" offers "Search: back", then "Title: back", then fields starting with "back".
- Picking "Search: back" sends `search=back`; picking "Title: back" sends `title.contains=back`.
- `status:draft,published` becomes one chip sending `status.in=draft,published`.
- `createdAt>=2026-01-01` sends `createdAt.gte=2026-01-01`.
- `author:` offers authors by name, with counts under `values: present`.
- `colour:red`, on a bar with no such field, stays marked text and sends nothing.
- Backspace in the empty input reopens the last chip as text.
- Switching the same bar between `Ui.AbovePlacement` and `Ui.SearchPlacement` leaves its address unchanged.
- Every rule is pinned both ways in `modules/ui/tests/`; every `search-tokens.json` row passes in the renderer.

## 5. `ui-react` and `ui-react-radix`

- **`ui-react`** draws the placement as a combobox:
  - a text input holding the chips, with a list of suggestions in sections;
  - the ARIA combobox pattern, so a screen reader announces the highlighted suggestion and each chip's removal;
  - token parsing as `search-tokens.json` pins it.
  - It is built from the existing controls: the text input, the floating list the pickers use, and the chip `summary: chips` uses. `ui_react_controls-2` is unchanged.
  - The part list gains `search-box`, `search-token` and `search-suggestions`.
- **`ui-react-radix`** styles the three parts.

**Docs:** the renderer docs gain the placement.

**Verify:** the renderer's package tests cover keyboard use (arrows, Enter, Escape, Backspace) and every `search-tokens.json` row.

## 6. Example

The authors/posts page set in `examples/ui-showcase` gains a posts screen whose bar uses `Ui.SearchPlacement`, over a posts collection declaring `query.search`, with a test under its own `tests/`.

## 7. Guides, primer, ledger

- **`apps/hub/guides/build-ui.md`** and **`apps/authoring-agent/chat/primer.md`**: `query.search`, the search field, `Ui.SearchPlacement`, the token spelling.
- **`docs/guides/what-you-get.md`**, under Standard library: "Search and filter in one box". One input that searches the declared properties and turns typed or picked text into filter chips (`status:draft`, a related record by name); the address stays shareable; a search over a property that is not text is refused before the app runs.
- **`modules/CLAUDE.md`**: the Declarative UI paragraph gains the search placement.

## 8. Checks to run before building on them

Each was confirmed by reading code, not by running it. Check each with a minimal manifest first; where one fails, the generic extension it names is part of this work:

1. The floating list the pickers use can draw sections. If not, sections are drawn around it as composition.
2. A referrer rule declared on a placement kind can read the referring bar's `policy` and `fields`, as `UI_FILTER_PINNED_UNUSED` already does for `Ui.AbovePlacement`.
3. A filter field schema can make `property` absent for one operator only, keeping `UI_FILTER_DUPLICATE` and preset matching keyed on the pair.

## Releases

One fragment per module, each written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `data-model` | `Added`, describing the break | `query.search`; `search` is now a reserved query name |
| `crud` | `Added` | answers `search` |
| `ui` | `Added` | the search field, `Ui.SearchPlacement`, the token spelling |
| `ui-react` | `Added` | the search placement |
| `ui-react-radix` | `Added` | styles for the search placement |

A changeset goes on each changed package that changesets versions, including `@telorun/ui-react-contract` if the part list moves.

**`requires:` floors:** none. This adds no grammar: `query.search` and the placement are the modules' own vocabulary. A module gets a floor only if running the previous published CLI against it, with the block stripped, rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`.
