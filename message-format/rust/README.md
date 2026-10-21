# telorun-message-format

The Rust half of `@telorun/message-format` (`message-format/nodejs`). It answers as that package answers for every input both can hold:
- the same model and the same problems, each with the same code, message, path and UTF-16 range;
- the same text and category for every number;
- the same lookup.

The profile, the rules and the reasons behind them are in `message-format/nodejs/CLAUDE.md`.

## Rules

- **No dependencies**, normal or dev. `src/` reads exactly the three CLDR files and their `LICENSE` from `message-format/cldr/`, at build time (`include_str!`). Parsing the data is the crate's own job (`json_value.rs`). A data file that does not read is a defect of the build and panics naming the file.
- `CLDR_LICENSE` is the Unicode License V3 text of the embedded data, and a program that ships the crate ships the text with it. `CLDR_VERSION` is checked against every data file when the tables first load.
- The crate is `publish = false`, licensed MIT, and carries `@telorun/message-format`'s version.

## Surface

| Function | Answer |
| --- | --- |
| `parse_pattern` | `Result<Pattern, MessageProblem>` |
| `read_message`, `read_text` | Read a `JsonValue` (build one with `parse_json` or `JsonValue::object`). Answer `Result<_, Vec<MessageProblem>>`. |
| `format_message` | Takes a `HashMap<String, MessageValue>`. `MessageValue` is `String`, `Int(i64)`, `Uint(u64)` or `Double(f64)`. Answers `Result<String, MessageFormatError>`. |
| `format_number`, `plural_category` | Take a `NumberValue`. |
| `plural_category_of_decimal` | Answers `None` for text that is not a UTS #35 decimal. |
| `serialize_pattern`, `message_identity`, `text_identity`, `message_variables`, `unknown_variables`, `plural_categories`, `invalid_plural_categories`, `truncation_chain`, `lookup_language` | As in Node. |

## Files

Each file twins the `message-format/nodejs/src` file of its name, kebab-case becoming snake_case, and `lib.rs` twins `index.ts`.
- `cldr_data.rs` twins the generated `cldr-data.ts`: it embeds the same files that module is written from.
- `cldr_tables.rs` twins `cldr-tables.ts` and also reads the data into tables.
- `json_value.rs` alone has no twin: a JavaScript host hands the core a value `JSON.parse` already built. It keeps ECMAScript's own-property key order (array-index keys first, ascending), so faults are reported in Node's order.

## Where it differs from Node

- **A value outside the enum.** Node refuses a boolean, `null`, an object (a timestamp included) and a `bigint` outside int64 ∪ uint64. Here those cannot be passed at all; a host converting its own values refuses them itself.
- **An unpaired surrogate.** Node refuses one in a pattern. No Rust string holds one.

## Tests

- `tests/conformance.rs` runs every row of `message-format/conformance/` and every CLDR sample in `message-format/cldr/plurals.json`, pinning each set's count as the Node runner does.
- `tests/crate_surface.rs` covers the embedded licence and the JSON reader's key order and escapes.
