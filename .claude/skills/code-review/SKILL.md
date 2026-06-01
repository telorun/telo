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
- adherence to Telo's core goals

Ignore any deviations from the implementation plan or spec, as long as the implementation is sound and meets the core goals.

Detect if implementer was struggling with making the implementation natural and decided to hack around.

Ground your feedback in specific file paths and line ranges. Provide actionable recommendations for improvement, and prioritize them based on impact and effort.

Make sure there is no major version bump in any of the packages or modules.

Ignore any file changes that are not coherent with the overall feature or fix being implemented and seem out of scope.
