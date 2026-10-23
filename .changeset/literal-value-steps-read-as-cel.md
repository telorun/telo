---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/cel": minor
---

A module variable or secret declared `type: integer` or `type: number` now holds that representation for every reader, at the root Application and in every Library import — whether the value came from a default, the environment, the command line, a literal an importer wrote or an importer's own variable (an integer, as long as int64 can hold it). `!cel "variables.boost * 20"` used to pass `telo check` and fail at run with `no overload of "*" takes (double, int)`; it now runs. Two imports of a `lifecycle: shared` library supplying the same integer in different spellings (a literal and a forwarded variable) now agree.

A number written literally in a pure `value:` step now reads in CEL as the same number written in CEL would: an int when it is integral and within int64, a double otherwise — as the whole value and at any depth of a literal map or list. `value: 3` then `!cel "steps.count.result * 2"` used to pass `telo check` and fail at run with `no overload of "*" takes (double, int)`; it now runs. The rule reads the value, not its spelling, so `3.0` and `1e3` are ints, and an integral number outside int64 (`1e30`) stays a double. A number a `!cel` or `!interpolate` member computes is left as computed.

`telo check` types `steps.<name>.result` of a literal step by the same rule: a literal map is a closed record, and a list is typed by its elements when they all agree. So that such a record still meets a map across a condition, the CEL type join now reads a record as the string-keyed map it is: a record against a map, or against a record of another shape, joins to `map<string, …>` over their value types — `cond ? steps.flags.result : {'ok': true}` checks — where the branches used to be refused as not one type; a record against a scalar or a list is still refused.

**Behaviour changes:**

- A declared integer variable or secret is an int64 for every reader, not only for CEL, so a controller handed `!cel "variables.x"` at a config slot receives an int64 (a `BigInt`) where it used to receive a plain number. A controller doing arithmetic on such a slot reads it with `integerInput` from `@telorun/sdk`.
- `value: 3` then `steps.count.result * 2.0` ran before and is now refused — `CEL_TYPE_ERROR` from `telo check`, and `telo run` refuses the manifest at load. Write `value: !cel "3.0"` for a double 3, or multiply by an int.
- A literal step's result is typed, so an expression that only worked because it was untyped is a static error: `value: 3.5` then `* 2`, `value: 3` then `+ "a"`, a literal string passed to a function that takes a number.
- A literal step's result no longer meets `null` in a condition: `has(steps.x) ? steps.x.result : null` over a literal-map step is `CEL_TYPE_ERROR`, as `true ? 1 : null` always was. Write `has(steps.x) ? dyn(steps.x.result) : null`.
- A member a literal map does not hold is `CEL_UNKNOWN_FIELD` — `steps.flags.result.misspelled`, and also under `has(steps.flags.result.absent)`, which used to answer `false`.
- `steps.<name>.result` is typed only when every step of that name produces the same type, where the last step written used to type the name alone. A pair that disagrees (`then: value: 3` / `else: value: !cel "2.5"`) is untyped, and an expression step reads its own name as what the other steps of that name produce: a loop seed `value: 0` advanced with `!cel "steps.i.result + 1.0"` is refused by both halves — write `+ 1`.
- A misspelled step name in a body with a `value:` step is reported once, as `"frist" is not declared here (declared: …)`, where it was reported twice in two wordings.
- A literal step's integers reach a controller as an int64 when forwarded — `value: 5000` then `timeoutMs: !cel "steps.t.result"` hands the controller a `BigInt` where it received a plain number. A controller reads such a slot with `integerInput` from `@telorun/sdk`.
- A durable run resumed from a journal written before this change replays the double it recorded for a literal step, not an int.
- `value: !cel "self.<field>"` in a step body a templated kind declares — in a body entry or in a `with:` member nested in one — or a `base:` mapping builds for its parent, is now evaluated when the step runs rather than resolved once when the instance is created, as is any expression inside a step's `value:` there. A number the instance supplies is therefore never read as one written in the step: `ratio: 3` declared `type: number` stays a double.
