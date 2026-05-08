---
"@telorun/kernel": patch
---

Remove `@telorun/yaml-cel-templating` package and the `$let`/`$if`/`$for`/`$eval`/`$include` YAML directives. The package was unused — no manifest in the repo referenced any directive and no kernel code imported it. Static analyzability of manifests is a core architectural goal, and structural directives that produce resources at runtime are at odds with it. Plain `${{ }}` CEL interpolation continues to work as before.
