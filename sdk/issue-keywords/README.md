# Issue keywords

The closed vocabulary a finding about a refused value is written in — one JSON
file per keyword, named `<keyword>.json`, read as one lexically ordered set. A
finding is `{ pointer, keyword, params }`: where in the value it is (a JSON
Pointer), what was violated, and the facts a reader words it from. It carries
no prose, so whoever shows it to a person words it, in their language.

| key       | meaning |
| --------- | ------- |
| `keyword` | The keyword, exactly the file name without `.json`. |
| `params`  | The names of the facts a finding under this keyword carries, in `params`. A finding carries only these, each one the validator reported. |

The keywords are the JSON Schema keywords the validators report, with the
names of the parameters they report them with. A finding under any other
keyword — `anyOf`, `not`, a Telo annotation — is `invalid`, with no params:
its facts are no part of the vocabulary, so a reader cannot be expected to word
them. A value of a Telo value type that does not read (`Telo.Timestamp`,
`Telo.Url`) is `format`, its `format` param naming the type.

Who writes findings in it: the HTTP server's 400 for a request its route
refuses (`data.issues`), and the runtime's own refusals of a value at a
contract boundary or a transport's inbound value (`ERR_INPUT_INVALID`'s
`data.issues`).

`scripts/copy-issue-keyword-entries.mjs` (the root `prepare`) copies the files
into `sdk/nodejs/src/issue-keywords/entries/` with a barrel emitted from the
same listing, read by `@telorun/sdk`'s `issueKeywords()` / `valueIssue()`. The
set is Node-only for now: the Rust kernel raises none of the findings that use
it and embeds no copy, and the `Telo.Builtins` archive does not carry it.
