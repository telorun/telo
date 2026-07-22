---
name: code-review
description: Read-only code review for staged changes or current branch.
---

Perform a read-only code review for staged changes or the current branch. Do NOT modify any files.

Determine whether the implementation is sound, sustainable long-term, and aligned with Telo's core goals:

- **Polyglot architecture** — Telo must support controllers and runtimes in any language, not just Node.js
- **Visual editing** — Telo manifests must remain visually editable in a GUI editor; solutions must not break declarative structure or introduce constructs that can't be represented visually
- **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; solutions must not introduce unnecessary overhead
- **Static analysis — THE SINGLE MOST IMPORTANT GOAL IN TELO** — YAML manifests must remain statically analyzable; solutions must preserve the ability to validate references, type-check CEL expressions, and detect errors without running the kernel. This is NON-NEGOTIABLE and OVERRIDES every other consideration, including the "ignore plan deviations" rule below. Static analysis must NEVER be deferred, omitted, weakened, or left as a "follow-up" — not even when the plan/spec explicitly says so. If the kernel validates something at runtime that the analyzer does not catch statically, that is ALWAYS a top-priority blocking finding, regardless of whether it was a documented, intentional deferral. A documented deferral of a static check is not an excuse — it is exactly the defect to flag most loudly.
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
- check if implementation introduces runtime validation in kernel but does not align analyzer to catch it at static analysis time.
- check if implementation can become a threat for static analysis.
- make sure that kernel, analyzer, and editor do not know anything about standard modules in `./modules`.
- check if implementation can't be ported to other languages (rust, go)
- check if a fix is treating the cause of the problem instead of just the symptom, and is not a hacky workaround.
- check if code was added to a file that suffers from a large number of responsibilities and should be split into smaller files.

Ignore any deviations from the implementation plan or spec, as long as the implementation is sound and meets the core goals. EXCEPTION: never ignore a gap in static analysis — see the Static analysis goal above. A missing/deferred static check is always a blocking finding even if the plan sanctioned it.

Detect if implementer was struggling with making the implementation natural/simple and decided to hack around.

Ground your feedback in specific file paths and line ranges. Provide actionable recommendations for improvement, and prioritize them based on impact.

Make sure there is no major version bump in any of the packages or modules.

Ignore any file changes that are not coherent with the overall feature or fix being implemented and seem out of scope.

Do not comment about what is sound about the implementation, only point out potential issues and areas for improvement.

Provide concrete fix recommendations for each issue you find, and explain why the fix is necessary.