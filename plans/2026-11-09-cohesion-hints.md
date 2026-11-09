---
status: draft
priority: medium
depends-on: []
packages: [analyzer/nodejs, cli/nodejs, packages/language-server, docs, apps/authoring-agent]
---

# Cohesion hints for applications and their nested libraries

## Problem

Nothing tells an author that their application's structure has drifted. Today:

- A library inside the app's directory can hold two unrelated features — accounts and billing, sharing no resource, kind or function. `telo check` says nothing, and every reader of the library has to discover the seam themselves.
- A library can export a kind or an instance that nothing in the app uses, or keep an internal resource that no export reaches. Both pass silently.
- A resource can be declared as its own top-level document while exactly one place references it. The repo's style rule says to declare it inline, but no check enforces it.
- An application can hold two independent groups of resources (two servers sharing nothing) with no hint that one of them is a library waiting to be extracted.

The analyzer already has every fact needed: references, `extends`, template bodies, CEL reads of `resources.X` and module calls are all declared, so structure can be computed exactly instead of estimated.

## Solution

A new analysis pass emits four **hint**-severity diagnostics, all prefixed `COHESION_`. It runs only when the entry is a `Telo.Application`, and covers:

- the application module itself, and
- every library **nested in the application's directory** — its `telo.yaml` lies under the entry manifest's directory and every importer of it is the app or another nested library. This is the rule `telo publish` uses to ship a library inside the app's artifact.

A library outside the app's directory is never analyzed: other importers may exist, so its usage is not closed-world. A `Telo.Library` entry produces no cohesion hints.

**The graph.** One undirected graph per module, built from facts the analysis already computes (the call graph, the reference reach, CEL read chains, module calls). It adds no walk of its own.
- **Nodes** are the module's declarations: resources, kind documents (`Telo.Definition`, `Telo.Abstract`, `Telo.NeedType`), named shapes and functions. An inline declaration, a template-body entry and a `with:` scope member are part of their holder's node.
- **Edges** are `!ref` and inline reference slots, `extends`, a resource of `kind: Self.<Kind>` to that kind, a kind's slot constraint or schema `$ref` naming an own kind or shape, template-body references, `resources.<name>` reads and `Self.fn(…)` calls.
- **Not edges:** a shared import, or shared `variables` / `secrets` / `needs` / `resources:` inputs. Each library resulting from a split would simply take the input.
- Over choices (`!if`, `!switch`, …) the graph is the union of every configuration, so an edge present in any configuration counts.

**The four hints:**

- **`COHESION_UNUSED_DECLARATION`** (tag `Unnecessary`, rendered faded). Raised for:
  - an export of a nested library that nothing in the application uses — a `kind:`, `!ref`, `resources.<Alias>.<name>`, `<Alias>.fn(…)`, `extends:` or slot constraint, reached directly or through another nested library's re-export that is itself used;
  - an internal declaration that no export reaches.

  Anchored at the `exports:` entry, or at the kind document when the library declares no `exports:` block; at the declaration for an internal one.
- **`COHESION_SPLIT_LIBRARY`**: the used exports of a nested library fall into two or more components. Anchored at the library's `metadata.name`. The message lists each group's exports, where in the app each group is used, and the inputs each new library would take.
- **`COHESION_INLINE_RESOURCE`**: a resource is named by exactly one reference, at a slot that accepts an inline declaration. Not raised when the resource:
  - is read by CEL,
  - is listed in `targets:`,
  - is exported,
  - has capability `Telo.Mount` (a router stays named so it can be tested on its own), or
  - is the target of a declaration-read (`use: schema`) slot.

  Applies to the app and to nested libraries, anchored at the resource's `metadata.name`, naming the referrer and the path to inline it at.
- **`COHESION_EXTRACT_LIBRARY`**: the application's declarations fall into two or more components of at least two declarations each. Edges from the Application document itself (`targets:`, `logging:`, `tracing:`, `translations:`) are not counted. Anchored at the application's `metadata.name`, it lists every component except the largest as a candidate nested library.

**Where it shows:**
- **Editor:** the language server publishes each hint on the file that declares its anchor, including a nested library's own file.
- **`telo check`:** prints hints with the label `hint` (today every non-error is printed as `warning`). They are not counted as warnings and never change the exit code. Under `-o json` they carry `"severity": "hint"`. Hints that are internal markers of the analysis stay unprinted.

## Decisions

- **Closed world only.** Hints are limited to the app and libraries nested in its directory, because there the analysis sees every importer, so a dead export is really dead and a split breaks nobody. Rejected: published libraries, where usage is unknowable without hub data.
- **A split is decided by structure, not usage.** In a closed world the app uses every group that is still live, so module-level usage never separates groups. Resource-level usage would suppress the common case of one router using both halves. The usage goes in the message as evidence instead.
- **Shared inputs and imports are not cohesion.** Two halves on one connection or one `variables.region` stay two features. Counting them would hide almost every split.
- **Unused exports are taken out before grouping.** A library with one used group and one dead group gets the unused hints only, not a split as well.
- **Hint severity, no suppression key.** Hints never fail a check or a build. A manifest key whose only purpose is silencing advice would be surface that every reader and Studio must carry. A deliberately bundled library keeps a faded hint.
- **No automatic repair.** A `DiagnosticFix` replaces one node's value, and inlining or splitting moves documents, which that primitive cannot express.
- **The inline exception is decided by capability, not by kind name** (`Telo.Mount`), so the analyzer still hardcodes no resource kind.
- **Extraction needs at least two declarations per component.** Moving a single declaration into a library of its own adds an import and groups nothing.
- **Known limit:** a nested library imported by another Application inside the same directory tree is invisible to this entry's analysis, so it can be reported as unused. Accepted, because hints are advisory and that layout is unusual.

## Example after the change

An application `Shop` whose directory holds `accounts/telo.yaml`, a library exporting `register`, `login` and `invoice`. `invoice` uses a `Sql.Query` that shares only the library's `connection` input with the other two. `Shop` also declares a `db` connection that only the library import references. `telo check ./telo.yaml` exits 0 and prints:

- `accounts/telo.yaml:3:9  hint  Library 'Accounts' holds 2 groups that share nothing: {register, login} (used by Shop's 'api') and {invoice} (used by Shop's 'billingJob'). Consider splitting it; each would take the 'connection' input.  COHESION_SPLIT_LIBRARY`

`db` gets no inline hint, because a `resources:` supply at an import is not an inline-capable slot.

## Verify

- Analyzer unit tests, with one fixture app per hint and one per exception: CEL read, `targets:`, export, `Telo.Mount`, schema slot, single-declaration component, unused group not also reported as a split, edge present in only one configuration, re-export counted as use, library outside the app's directory analyzed for nothing, `Telo.Library` entry analyzed for nothing.
- `telo check` on the fixture prints `hint` lines, exits 0, reports `"severity": "hint"` under `-o json`, and prints no analysis-internal marker.
- In VS Code, the split hint appears on the nested library's own file, and an unused export renders faded.
- `telo check` over every `examples/` and `starters/` application: review each hint by hand, and fix any false positive that a rule above should have caught before shipping.
- Analysis time of the largest example is unchanged within noise.

## Bookkeeping

- One changeset for the telo line (analyzer and CLI).
- A guide `docs/guides/cohesion-hints.md` covering the four hints, the closed-world rule and the exceptions.
- A benefits-ledger entry under Telo itself: structure suggestions for the author's own app.
- The analyzer guide gains the pass. The authoring-agent primer states that a manifest it writes should raise no `COHESION_` hint.
