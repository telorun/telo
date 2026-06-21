---
name: code-review
description: Read-only code review for staged changes or current branch.
---

Perform a read-only code review for staged changes or the current branch. Do NOT modify any files.

Determine whether the implementation is sound, sustainable long-term, and aligned with Telo's core goals:

- **Polyglot architecture** — Telo must support controllers and runtimes in any language, not just Node.js
- **Visual editing** — Telo manifests must remain visually editable in a GUI editor; solutions must not break declarative structure or introduce constructs that can't be represented visually
- **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; solutions must not introduce unnecessary overhead
- **Static analysis** — YAML manifests must remain statically analyzable; solutions must preserve the ability to validate references, type-check CEL expressions, and detect errors without running the kernel
- **Developer friendly** — Errors must not be swallowed; they should be surfaced clearly to developers. Error messages must be actionable and informative, guiding developers to concrete place in YAML manifest that needs fixing.

Focus on:

- architecture and design of the code
- encapsulation and modularity
- cohesion and coupling
- dependency inversion violations — flag a class that constructs its own concrete dependencies instead of depending on the abstraction and receiving them (constructor injection / factory). Watch for boolean flags whose only purpose is to switch hardcoded constructions on/off: the decision of *which* concretions exist is a composition-root concern and must not leak into the class. The fix is one injection seam (plus an exported factory for the common default set), not a growing list of toggles.
- adherence to Telo's core goals
- check if generic packages are aware of specific packages, eg. 
  - both `kernel` and `sdk` must not be aware of: any module in `./modules`, any package in `./packages`, `editor`, `cli`
  - `editor` should not be aware of any module in `./modules`
  - more generic module in `./modules` must not be aware of more specific module in `./modules`

Ignore any deviations from the implementation plan or spec, as long as the implementation is sound and meets the core goals.

Detect if implementer was struggling with making the implementation natural and decided to hack around.

Ground your feedback in specific file paths and line ranges. Provide actionable recommendations for improvement, and prioritize them based on impact and effort.

Make sure there is no major version bump in any of the packages or modules.

Ignore any file changes that are not coherent with the overall feature or fix being implemented and seem out of scope.

Do not comment about what is sound about the implementation, only point out potential issues and areas for improvement.