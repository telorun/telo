---
"@telorun/analyzer": patch
"@telorun/kernel": patch
"@telorun/sdk": patch
---

An integer a consumer writes now reaches CEL as an integer inside a template body, as `telo check` already typed it: `self.factor * 10` and `each.value.factor * 10` over a declared `integer` no longer fail at run with "no overload of * takes (double, int)". `self`, a loop's binding and the values a choice or repeat is decided over are read through the schema the kind declares (a map's values and a list's items included), and a collection with no declared type follows the rule a pure step's literal `value:` does. A bare `self.<path>` forwarded into an entry still reaches its controller as written. `@telorun/sdk` exports `literalStepValue`, the literal rule the step engine already used.
