---
name: analysis
description: Analyze a problem or feature request from first principles. Proposes the ideal architectural solution and then verifies it against the codebase.
---

Do NOT modify any files. This is a read-only analysis task.

## Step 1: Analyze

Use the Agent tool to spawn the `analyst` agent with the following prompt:

> Analyze this problem for the Telo declarative runtime: $ARGUMENTS
>
> Rules:
> - Disregard existing implementation. Treat the system as if it could be rewritten from scratch.
> - Think from first principles. What is the ideal design given the system's goals and constraints?
> - Be concrete. Propose specific data structures, interfaces, control flow, and resource interactions.
> - Consider trade-offs. Present the recommended approach alongside alternatives you considered.
>
> Structure your response as:
> 1. **Problem definition** — restate the problem, identify core requirements and constraints
> 2. **Ideal architecture** — key abstractions, data/control flow, interfaces, integration with the kernel lifecycle (init loop, CEL evaluation, controllers, capabilities)
> 3. **Trade-offs considered** — alternative designs and why the proposed approach is better
> 4. **Impact surface** — which parts of the system this touches
> 5. **Open questions** — decisions that need user input
>
> Read CLAUDE.md for architectural context.

## Step 2: Review

After receiving the analyst's proposal, spawn the `reviewer` agent with this prompt:

> A solution was proposed for: $ARGUMENTS
>
> Here is the proposed solution:
> [include the full analyst output here]
>
> Disregard existing code. Review this purely as an architectural proposal. Evaluate whether it:
> 1. **Makes sense** — is the design coherent and well-reasoned?
> 2. **Is sustainable long-term** — will this hold up as the system grows, or will it become a liability?
> 3. **Supports polyglot architecture** — does it work across languages, or does it couple to a specific runtime?
> 4. **Supports visual editing** — can this be represented and edited in a GUI manifest editor, or does it break declarative structure?
> 5. **Preserves performance** — does it introduce unnecessary overhead in the init loop, CEL evaluation, or resource resolution?
> 6. **Preserves static analysis** — can manifests using this solution still be validated, reference-checked, and CEL type-checked without running the kernel?
>
> Read CLAUDE.md for architectural context about Telo's goals and design principles.
>
> Structure your response as:
> - **Verdict**: sound / has issues / fundamentally flawed
> - **Issues found** (if any): list each with explanation of the architectural concern
> - **Suggestions**: concrete improvements to address each issue

## Step 3: Present

Combine both outputs into a final report for the user:

### Analysis
[analyst output]

### Review
[reviewer output]

### Final recommendation
Synthesize both into a concise recommendation, incorporating the verifier's feedback into the analyst's proposal where applicable.
