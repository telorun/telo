---
"@telorun/templating": minor
---

CEL gains a formatting layer, and `cel.bind` becomes usable.

**Formatting.** `format(x, spec)` takes a d3-format specifier in full
(`[[fill]align][sign][symbol][0][width][,][.precision][~][type]`), with `fixed(x, digits)`
as the two-decimal-places case and a second arity on `round(x, digits)` sharing the same
rounding rule, so a rounded value and the cell rendered beside it cannot disagree at the
boundary. `formatDuration(minutes, minutesPerDay)` renders `1d 30m` against a declared day
length. `dateIn`, `isoIn`, `startOfMonth` and `addMonths` take an instant and an IANA zone
(UTC by default); `addMonths` clamps the day of month. `compact` drops null and empty-string
entries from a map or list.

The locale is pinned to ASCII rather than defaulted: d3-format renders a negative with
U+2212 MINUS SIGN, so `format(-1.5, '.2f')` would otherwise be a string no downstream
parser reads as a number. A CEL `int` is an int64 and d3-format throws on one, so `format`,
`fixed` and `round` convert — and raise above 2^53, where a double stops representing
every integer, rather than emitting a number the author did not compute.

**Behaviour change:** `round(x)` now raises on an integer past 2^53 instead of returning a
neighbouring one. It previously answered `round(9007199254740993)` with
`9007199254740992`, silently. Guarding only the new two-argument form would have left that
reachable by writing one fewer argument.

**Guards fire at `telo check`, not only at run time.** A catalog entry can carry a
`checkArgs`, called from the analyze path with the value of every argument written as a
literal, so an unparseable specifier, a digit count out of range, a day length of zero, an
unknown IANA zone and an integer past 2^53 are each a `CEL_INVALID_ARGUMENT` error on the
offending line. Each checker calls the same guard the runtime calls, so the static and
dynamic answers cannot disagree. `format`, `fixed`, `round`, `formatDuration` and `compact`
also register per-type overloads instead of `dyn`: `format('abc', '.2f')` used to evaluate
to the string `"NaN"`, and `compact` turned an instant into `{}` and a byte buffer into
`{"0":137,…}`.

**Zoned calendar arithmetic no longer changes the day across a DST gap.** `addMonths` and
`startOfMonth` resolved a wall clock by a fixpoint, which settles *backwards* when the
requested time does not exist — so adding a month to midnight in Santiago or Havana landed
on the previous day, silently, which is the one thing those functions exist to control.
Resolution now follows Java's `ZonedDateTime` and Temporal's `compatible`: an ambiguous
wall clock takes the earlier instant, and one that does not exist shifts forward out of the
gap. An unknown time zone is refused in this family's voice rather than as a raw
`RangeError`, and the decimal-places bound applies to a specifier's precision too, so
`format(x, '.11f')` no longer routes around the limit `fixed(x, 11)` enforces.

Conformance is a manifest (`tests/cel-formatting.yaml`) rather than assertions inside this
package's tests: the specifier grammar crosses runtimes while the library implementing it
does not, and a manifest is the artifact every Telo runtime already executes — so a second
CEL engine conforms by running it, with an int64 and an instant written in CEL rather than
encoded into a harness format.

**`cel.bind`.** The parser expands `cel.bind(name, init, body)` into a receiver call on a
bare `cel` identifier, and nothing in the analyzer knew that — so a manifest using CEL's
only binding form got an unknown identifier for the bound name, unknown-field errors for
each of its uses, one for the `cel` pseudo-receiver, and a fabricated "there is no method
`bind`" whenever the type-checker rejected the expression for any unrelated reason. Both
CEL walks now scope the bound name to the body, leave `init` in the enclosing scope, and
ignore the receiver; `bind` joins the recognised macro set. Six analyzer passes consume
that walk and are repaired by the one change, including CEL binding-order derivation, which
could read a bound name as a dependency on a sibling binding and raise a spurious
`BINDING_CYCLE`.
