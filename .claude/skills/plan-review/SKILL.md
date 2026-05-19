---
name: plan-review
description: Read-only review of an implementation plan.
argument-hint: Selected file
---

Perform a read-only review of an implementation plan. Do NOT modify any files (including the plan itself).

Determine whether the proposed plan is sound, sustainable long-term, and aligned with Telo's core goals:

- **Polyglot architecture** — Telo must support controllers and runtimes in any language, not just Node.js
- **Visual editing** — Telo manifests must remain visually editable in a GUI editor; the plan must not break declarative structure or introduce constructs that can't be represented visually
- **Performance** — the init loop, CEL evaluation, and resource resolution must stay fast; the plan must not introduce unnecessary overhead
- **Static analysis** — YAML manifests must remain statically analyzable; the plan must preserve the ability to validate references, type-check CEL expressions, and detect errors without running the kernel

Focus on:

- architecture and design of the proposed solution
- package boundaries, dependency direction, and where code lives
- encapsulation, modularity, cohesion, and coupling implied by the plan
- whether the plan reaches for a generic primitive or a use-case-specific shortcut (default should be the generic primitive)
- whether `JS.Script` is being used where a new resource kind would be a better fit
- scope creep, missing steps, unstated assumptions, and risks
- adherence to Telo's core goals
- whether the plan contains redundant text that doesn't add value for implementers

Never mention:

- minor implementation details that don't affect the overall soundness of the plan
- gaps that can be easily filled in during implementation without affecting the overall design
- backwards compatibility issues - telo is not released yet and breaking changes are expected and desired

Make sure there is no major version bump in any of the packages or modules.

Ground your feedback in specific sections of the plan and, where relevant, specific file paths and line ranges in the codebase the plan affects. Provide actionable recommendations for improvement, and prioritize them based on impact and effort.

**Important**: Find alternative solutions or well known generic patterns that can be applied to the problem at hand, and suggest them if they would be a better fit than the proposed solution.

Provide only important feedback that would significantly improve the plan. Avoid nitpicks or minor style issues unless they have a meaningful impact on readability or maintainability.

Do not summarize what is sound about the plan.

List top 3 real issues in the plan.
Always be sure about the issues you list. If you are not sure whether something is an issue then investigate more.
Keep the list of issues very concise.
Never point to any source code or line numbers in the codebase. Focus on behaviour and design issues in the plan itself, not on implementation details.
