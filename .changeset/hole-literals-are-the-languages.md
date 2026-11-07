---
"@telorun/cel": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
---

A `${{ … }}` hole ends a quoted literal exactly where the language ends it: the hole reader no longer has a literal rule of its own and asks the engine, which exports `quotedLiteralEnd(source, quoteAt)` beside its lexer, held to the lexer by an agreement test over every short string. So `${{ r'\'' }}`, `${{ br'\'' }}` and a member name between backticks holding braces (`` ${{ m.`it's}}` }} ``) now read, `${{ r'\' }}` (a raw backslash takes its closing quote) never closes, `rb` and any other word before a quote mean a plain literal, and a comment is not read, so a quote after `//` opens a literal. The untagged-interpolation migration reads holes the same way, so one scalar of each kind changes between rewritten and left. A raw carriage return now ends a single-line string, bytes literal or quoted member name, unterminated, as a line feed does (a triple-quoted literal still holds it), and the CEL writer refuses a member name holding one. `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE` names the value in CEL's terms — `null`, `a list`, `a map`, `a value of type <type()'s name>` (`optional_type` for an optional, `type` for a type value) or `a value outside the CEL value domain` — where an optional and a type were both `a value of type Object`.
