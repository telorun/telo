---
status: draft
priority: high
depends-on: []
packages: [modules/data-model, modules/crud, modules/crud-ui, modules/ui, modules/ui-react, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
refinement: not-started
---

# Collection writes that change only what was edited, and never overwrite someone else's change

## Problem

The collection contract has one way to change a record: `PUT <basePath>/<key value>`, which replaces. Two defects follow, on every backend and every screen.

- **A screen clears what it never saw.** An edit form sends the record's properties its model declares, each field's value over them. A form over a model narrower than the collection's update shape therefore clears every property it does not name, and to avoid clearing what the list did not select it must read the record first, on every edit.
- **Two editors overwrite each other silently.** Nothing says which version of a record a write was made against. Between a form's read and its `PUT`, another viewer's change to the same record is lost, with no error on either screen.

What a collection accepts as a write is also undeclared outside `crud`: `DataModel.Collection` declares its filters, sorts and facets, but only `Crud.Collection` has `schemas`, so a screen over any other collection cannot be checked against what its API takes.

## Constraints

None.

## Surface

**Added**

- `PATCH <basePath>/<key value>` — in the collection contract: a JSON Merge Patch (RFC 7396), `Content-Type: application/merge-patch+json`, answering 200 with the stored record.
- `ETag` — response header a collection's `GET <basePath>/<key value>`, a record contract `GET` and every write answer may carry.
- `If-Match` — request header on `PATCH`, `PUT` and `DELETE`; a validator that no longer matches answers `412` with a problem body.
- `DataModel.Collection.schemas` — `{ create?, update? }`, each a `Telo.Type` reference: the body `POST` and `PATCH` accept. An absent one means the collection accepts no such write.
- `UI_WRITE_UNDECLARED` (twin `ERR_UI_WRITE_UNDECLARED`) — a form's default write to a collection declaring no matching shape.
- `UI_WRITE_SHAPE_MISMATCH` (twin `ERR_UI_WRITE_SHAPE_MISMATCH`) — a form model property the write shape does not declare, or declares with another type.
- `ERR_UI_PRECONDITION_FAILED` — `error.code` of a `412` whose problem names no code.
- `Crud.Api` route `PATCH <prefix>/{<idParam>}`, operationId `update<Singular>`; a strong `ETag` on read-one and on every write answer; `If-Match` honoured on `PATCH`, `PUT` and `DELETE`.
- `modules/ui/conformance/merge-patch.json` — the vectors a renderer's patch and precondition handling runs.

**Changed**

- `PUT <basePath>/<key value>` — leaves the collection contract; no renderer sends it.
- `Crud.Collection.schemas` — inherits `create` and `update` from `DataModel.Collection`, keeps `list` as its own key, still requires all three.
- `Crud.Api` route `PUT <prefix>/{<idParam>}` — stays, as operationId `replace<Singular>`, outside the contract.
- An edit form's request — `PATCH` of the changed properties, with `If-Match` when the record's read carried an `ETag`; no property outside the form's model is ever sent.

**Removed**

- None.

## Solution

**One update, and it merges.** A patch member holding a value sets that property; a member holding `null` clears it, after which it reads as absent (or as `null` where the model admits null); a property not in the body is unchanged. The merged record is held to the update shape whole: clearing a required property is a 400 with a `required` issue at `/body/<property>`, and a member outside the update shape is a 400 `additionalProperties`. `POST` is unchanged.

**A collection declares its write shapes.** `schemas.create` and `schemas.update` sit on `DataModel.Collection`, beside the query it already declares, so every screen over any collection is checked against what the API takes. `Crud.Collection` inherits them and adds `list`. A form's default write names the collection through its presentation: one to a collection with no matching shape is `UI_WRITE_UNDECLARED`, and a form model that does not fall within the shape is `UI_WRITE_SHAPE_MISMATCH`. Both are judged where the default write is declared — a listing's `create` / `edit` opener today — and refused again when the resource is first read.

**The precondition is the server's to offer.** A server opts in by sending an `ETag`; there is no manifest key. The renderer keeps, per resolved request path — the key invalidation already uses — the `ETag` of the last read or write answer at that path. A `PATCH`, `PUT` or `DELETE` to that path carries it as `If-Match`, and a write's answer replaces it. A server sending no `ETag` gets no `If-Match` and behaves as today.

**A refused precondition keeps what was typed.** A `412` draws the form's or the action's `failure` with `error.code` `ERR_UI_PRECONDITION_FAILED` (the problem's own code when it names one) and announces the path as changed. Every reader of the path reads again and takes the new validator; the form keeps its entered values, so a second press sends them against the current record.

**The edit form sends its changes.** It still starts from the record read by its key. What it sends is the merge patch of the properties whose value differs from that starting record, an emptied field as `null`, with `If-Match` from that read. A form that changed nothing sends an empty patch, which the collection answers with the stored record.

**`Crud.Api`.** `PATCH` sets the columns the patch names and leaves the rest. The `ETag` is a digest of the stored record in the `model` shape. `If-Match` is compared inside the write's own transaction, with the row read under its write lock, so two concurrent writes against one validator cannot both succeed. `CrudUi.Admin`'s generated forms take the collection's `schemas`, as they do today.

**Before / after.** Before, two people open task 7, both save, and the first change is gone; a form over `{ title }` clears the task's `notes`. After, the second save answers `412`, the screen reads the task again and keeps what was typed; the narrow form sends `{ "title": … }` and `notes` is untouched.

## Decisions

- **JSON Merge Patch, not JSON Patch (RFC 6902).** A control sets a property's value; it never addresses a list position or needs operation order, and "absent is unchanged, `null` is cleared" is exactly what a client with a narrower model needs.
- **`PUT` leaves the contract rather than staying beside `PATCH`.** Two updates would let a renderer choose the one that clears unseen properties.
- **Conditional writes, not `PATCH` alone.** Without a validator two editors still overwrite each other on every property both changed.
- **No "accepts conditional writes" key.** The client that read a record holds its validator; a flag in the manifest could only disagree with what the server sends.
- **Write shapes on the generic collection.** A declaration only `crud` has leaves every other collection's screens unchecked.

## Verify

- A form over a model narrower than `schemas.update` leaves an unnamed column unchanged; the request body holds only the changed properties.
- `{ "dueOn": null }` clears the property; clearing a required one is a 400 with a `required` issue at `/body/<property>`; a member outside the update shape is a 400 `additionalProperties`.
- Two sessions read task 7; the first saves; the second save answers `412`, its reader reads again, its typed values stay, and a second press succeeds.
- Against a server sending no `ETag`, no request carries `If-Match`.
- Two concurrent `PATCH` requests carrying one validator through `Crud.Api`: exactly one answers 200.
- A default write to a collection declaring no `schemas.update` is `UI_WRITE_UNDECLARED`, and a form model property outside it `UI_WRITE_SHAPE_MISMATCH` — each refused at the declaring library and failing a consumer's run with its twin.
- A `DELETE` of a record changed since it was read answers `412` and the listing reads again.
- `ui-react` passes every row of `merge-patch.json`.

## Bookkeeping

Docs: `data-model` `collection-contract.md` and `collection.md`; `ui` `record-contract.md`, `action-contract.md`, `form.md`, `listing.md`; `crud` `api.md`, `collection.md` and its README; `ui-react` `urls.md` on invalidation and the kept validator; `crud-ui` `admin.md`. The CRUD and Declarative UI paragraphs of `modules/CLAUDE.md`, the authoring-agent primer, the hub `build-ui` guide. Each `UI_WRITE_*` rule pinned both ways in `modules/ui/tests/`. A ledger entry under Standard library, "Edits that never overwrite someone else's change". `Added` fragments describing the break for `data-model`, `crud`, `crud-ui`, `ui` and `ui-react`. `telo release floor` with the change.
