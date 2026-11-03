# Built-in error codes

One JSON file per code the runtime raises around every dispatch alike — the
**ambient** codes no kind declares (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`,
`ERR_FUNCTION_FAILED`, …) — read as one lexically ordered set and named
`<code>.json`. An entry is a throws-code entry with its code beside it, so it
reads exactly as a kind's `throws.codes.<CODE>` does:

| key           | meaning |
| ------------- | ------- |
| `code`        | The code, exactly the file name without `.json`. |
| `description` | What the failure means, for a developer. |
| `displayMessage` | The text a person is shown for it, a `Text` written in English (`en`). Its placeholders may name only the required string or number properties of `data`. |
| `data`        | Optional JSON Schema of the error's `data`. |

The display messages are what a renderer shows when nothing more specific
applies: the kernel attaches an entry's `displayMessage` to an ambient error
leaving a dispatch that carries none, so `error.displayMessage` holds it and a
translator may translate it. A catalog entry translating one of these texts is
never `MESSAGE_TEXT_UNUSED`: the built-in texts count as shown by every module.

Their translations live beside them in `sdk/translations/`, one text catalog per
language, layered beneath every catalog an application lists. Changing a
`displayMessage` here means changing its translation in every one of those files:
the archive is refused while a catalog translates a text no entry shows or leaves
one untranslated.

The files live **here**, beside the language halves, for the reason
`sdk/zone-attributes/` does: both kernels raise these codes and must attach the
same texts. `scripts/copy-error-code-entries.mjs` (the root `prepare`) copies them
into `sdk/nodejs/src/error-codes/entries/` with a barrel emitted from the same
listing; the Rust kernel embeds them with `include_str!`; the `Telo.Builtins`
archive carries them as its `errorCodes` section.

The set covers the SDK's `AMBIENT_CONTRACT_ERROR_CODES`: the SDK refuses to load
when an ambient code has no entry here, since it would reach a person as no text
at all, and the Rust kernel's tests fail when a file here is not embedded.
