# Lens: Engineering practices — rigor earned by triggers

**Applies to** whether to add a practice around the code — load tests, benchmarks, security and
dependency scans, fuzzing, coverage gates, environments, dashboards, alerts, runbooks, scheduled
jobs. Practices only: design is the other lenses', and analyzer diagnostics are product behaviour.
The horizon test shapes the design so a practice can arrive later; it never admits the practice.

## Principles, in ranking order

1. **A practice is added only on a trigger**, and it states the failure it catches and the
   threshold that fails it. Adding a practice later reshapes nothing, so waiting never forecloses
   the horizon.
2. **Day one only for failures that cannot be undone** — when the first occurrence is itself
   unrecoverable and nothing else prevents it: a secret leaving the machine, an unverifiable
   artifact published, data that cannot be regenerated without a copy. Severity alone never
   qualifies.
3. **A trigger is an observable fact:** a written requirement (a number or obligation in the
   component's docs, README or plan); a recorded failure of that class in that component; or a
   dependency fact — published to a registry, deployed for others than its authors, or on a path
   every manifest pays (init loop, CEL evaluation, analysis). "Important", "public-facing", "users
   will expect it" are not triggers.
4. **A trigger reaches its own component and its own failure class only.**
5. **Gate or nothing.** An admitted check blocks on its failure condition from its first day. A
   false finding is suppressed individually with a recorded reason; an alert demands action or
   does not exist.

## Distinguishing questions

1. Which failure does the practice catch, and what threshold fails it?
2. Which trigger holds, in which component?
3. Can the failure be undone once it happens?
4. Can the check block without false positives drowning it?

## Consequences

- **No failure condition** → not added.
- **No trigger** → "not yet"; the design stays additive so the practice can arrive. Adding it
  because the horizon anticipates it, or as a baseline for every component, is disqualified.
- **Irreversible and nothing else prevents it** → present from the first change that could cause
  the failure. **Recoverable** → waits for a trigger, however severe.
- **Trigger in one component** → the practice for that component and failure class. Spreading it
  repo-wide or to components of the same type is disqualified.
- **Cannot block without drowning in false positives** → not added. Report-only mode, promotion
  "later", or loosening the check to hide findings is disqualified.

**Always:**
- No coverage-percentage gate — a test per stated behaviour and per recorded regression.
- A one-off verification is measured once and recorded in the change, not made a permanent suite
  or scheduled job.
- No environment nobody exercises (staging for an app with no users).
- No operational tooling (dashboards, alerts, collectors) as a step of building a feature; the
  runtime's logging and tracing until a trigger asks for more.
- A practice arrives in its own change, naming its trigger and failure condition — never slipped
  into an unrelated change.
- A practice is removed in the change that removes its trigger.

## Horizon

A component's first external user · a written latency or throughput target · the first incident of
a class · 10× the components in the monorepo · a requirement dropped or a component unpublished ·
a compliance obligation.

## Verify

1. Every practice names its trigger and failure condition, and the trigger still holds.
2. No check runs report-only; every suppression carries its own reason; every alert that fired
   led to an action.
3. A component with no trigger carries only its behavioural tests and its irreversible-failure
   guards.
4. Every irreversible-failure guard exists from the first change that could cause the failure.
5. A change removing a trigger removes its practice.
