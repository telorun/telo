# Ui.ComponentExport

Publishes one browser component a module ships. It is declared in the library
that ships the code — a browser entry belongs to a `Telo.Library` — and exported
as an instance for applications to place.

| Field | | |
| --- | --- | --- |
| `entry` | required | the `specifier` of one of the declaring library's `exports.browser` entries |
| `export` | required | the name the component is exported under |
| `props` | required | the properties it accepts: a `Telo.JsonSchema`, `!ref` or inline |

```yaml
kind: Telo.Library
metadata: { name: Badges, version: 1.0.0 }
imports:
  Ui: oci://ghcr.io/telorun/ui
exports:
  resources: [statusPill]
  browser:
    - specifier: "@acme/badges"
      path: ./browser/badges.js
      source: ./browser/src/badges.tsx
      abi: ui_react-1
      external: [react, react/jsx-runtime]
      exports: [StatusPill]
---
kind: Ui.ComponentExport
metadata: { name: statusPill }
entry: "@acme/badges"
export: StatusPill
props:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    properties:
      done: { type: boolean }
```

An `entry` the library does not declare is `BROWSER_ENTRY_UNKNOWN`; an
`export` that entry does not list is `BROWSER_EXPORT_UNKNOWN`.

The component's files reach the application as `assets` on the composite that
places it — the built entry, its chunks and its stylesheet, each under the
entry's digest. There is no registry and nothing to configure on the
application. How entries are declared and built:
[Browser entries](https://telo.run/docs/extend/browser-entries).
