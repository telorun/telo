---
description: "Normative: how a root Telo.Application binds command-line flags and positional arguments to its variables and ports — the binding forms, the token grammar, value coercion, precedence, asking the host for a missing input and --help."
---

# Application arguments

Normative. How a root `Telo.Application` reads its command line. A kernel and a `telo` CLI
that bind Application inputs implement this exactly; the Node reference is
`readApplicationArguments` (analyzer, the bindings), `parseApplicationArguments` (kernel,
the tokens) and `resolveApplicationInputs` (kernel, the sources and §4.1). The Rust kernel
binds no Application inputs yet and refuses a manifest that declares them, and the Rust CLI
accepts no arguments after the path, so neither implements it today — §4.1 included, which
the Rust kernel owes the day it binds Application inputs.

## 1. Ownership

1. The command line belongs to the root Application. `telo run [options] <path> [arguments]`:
   every token after the manifest path is the application's, whatever it looks like. A
   packaged application receives every token after its program name.
2. `telo run`'s own options precede the path. Before the path, `--inspect` takes the next
   token as its value only when that token has the shape of a port (`9230`, `host:9230`,
   `[::1]:9230`); any other value is written `--inspect=<value>`.
3. No controller reads the command line. An imported library never binds it.

## 2. Bindings

An entry of the Application's `variables:` or `ports:` block may carry `arg:`. A `variables:`
entry binds `env:`, `arg:` or both; a `ports:` entry always binds `env:` and may add `arg:`.
Both rules exist because a runner session and an editor supply inputs through the
environment, never through the command line: a runner publishes a port before boot, and an
input only the command line could set would be one they could not start. `arg:` is one of:

| Form | Meaning |
|---|---|
| `arg: include` | the flag `--include` |
| `arg: { flag: filter, short: f }` | the flag `--filter`, also `-f` |
| `arg: { position: 0 }` | the first positional argument |

Refused, statically (`telo check`) and at load:

- A schema violation — a shape other than the three above or a key they do not name, a flag
  not matching `[A-Za-z0-9][A-Za-z0-9-]*`, a `short` that is not one letter, a negative or
  non-integer `position`, a `ports:` entry with no `env:`.
- `ARG_BINDING_ON_SECRET` — `arg:` on a `secrets:` entry. A command line is readable in the
  process table and in shell history.
- `LIBRARY_ARG_KEY_REJECTED` — `arg:` on a `Telo.Library` entry.
- `ARG_BINDING_INVALID` —
  - a `variables:` entry bound by `arg:` alone with no `default:`;
  - a flag starting `no-` (it would collide with a negation), or the reserved flag `help`;
  - an entry type other than `string`, `integer`, `number`, `boolean`, or `array` whose
    `items.type` is one of the four scalars (a port is implicitly `integer`);
  - a positional `boolean`, or an array of `boolean` on a flag;
  - two bindings sharing a flag, a short or a position;
  - positions that do not run `0, 1, 2, …` without a gap, or an array at any position but
    the last.

## 3. Tokens

Parsing reads the tokens left to right:

1. `--` ends options; every later token is positional.
2. `--<flag>=<value>` and `--<flag> <value>` bind a non-boolean flag; the second form takes
   the next token whatever it is. `--<flag>` sets a boolean to true, `--no-<flag>` to false;
   a boolean takes no `=` value.
3. `--help`, read as an option — not as a flag's value by rule 2, and not after `--` — answers
   the usage (§5) and resolves nothing else, whatever errors earlier tokens produced.
4. `-<short> <value>` binds a non-boolean short; `-<short>` sets a boolean. A value attached
   to a short (`-c2`, `-c=2`) and clustered shorts (`-ab`) are not accepted.
5. Any other token is positional. A token of the form `-<digit>…` is positional, so a
   negative number needs no escaping.
6. Positionals fill the positions in order; the last position collects every remaining
   token when it is an array.

Each of these is an error: a flag, short or `--no-` form nothing declares; a value attached
to a declared short, reported as the spelling to use instead (`write -c 2`); a flag with its
value missing; a non-array binding given twice; a positional with no position left. Every
error is collected — none stops the parse — and they join the Application's other input
failures in one `ERR_MANIFEST_VALIDATION_FAILED`, each naming what the Application declares.
An Application that declares no `arg:` refuses every token.

## 4. Values

A token is text, read by the binding's type: `string` as written; `integer` as an optional
`-` and decimal digits; `number` as a decimal number; for an array, each token by
`items.type`. It is never JSON-decoded (unlike an `env:` value of an array or object type).
An instance-typed entry (`x-telo-type`) reads the token through the type's plain encoding,
and a `Telo.HostPath` is anchored at the working directory, as for an environment value.
The result is validated against the entry's schema with `env`, `arg` and `default` removed.

For each entry the first source with a value wins:

1. a value supplied by name by whoever started the application (a parent `App.Instance`),
   validated but never coerced;
2. the command line;
3. the environment variable `env:` names;
4. `default:`;
5. an answer the host gives when asked (§4.1), reached only for an entry 1–4 leave empty.

An entry with none of them is an error naming each channel it binds.

### 4.1 Asking the host

A host may supply an **input resolver** when it loads an application. It is asked only
when every failure of the reading above is a missing value; any other failure — a token
§3 refuses, an `env:` value that does not decode or validate, a supplied name the
application does not declare — is refused at once, and nothing is asked. `--help` asks
nothing.

1. **What is missing.** The resolver is handed one entry per input with no value:
   - a `variables:`, `secrets:` or `ports:` entry with no value from 1–4 and no `default:`;
   - each required field of a required need reaching the root with nothing set in the
     environment its fields are read from (`telo needs report` lists the names) — the
     root's own needs and those bubbling up from imported libraries;
   - each missing required field of a need set only in part;
   - a `Telo.PublicUrl` field once neither its environment name nor the host's templates
     answer it, and a `Telo.DurableDirectory` field once neither its environment name nor
     `TELO_HOST_STATE_DIR` answers it.

   An entry with a `default:`, an optional need with nothing set, an optional field of any
   need and an entry whose supplied value is invalid are never asked for.
2. **Each entry** carries its identity — `variables.<name>`, `secrets.<name>`,
   `ports.<name>`, `needs <need path>.<field>` — the environment variable it binds, its
   command-line spelling when bound, whether it is sensitive (a secret, or a need field
   marked `x-telo-sensitive`), its type as §5 names it, the schema an answer is validated
   against, its `title` / `description`, and — when an earlier answer was refused — the
   refusal's sentence, which never quotes a sensitive value.
3. **An entry whose value depends on another missing entry is held back** until that
   entry has a value: a `Telo.PublicUrl` the host's main template would derive from a
   port that has none is neither asked for nor refused while the port is missing.
4. **An answer is text**, decoded exactly as the same text in the `env:` variable would
   be — JSON for an `object` or `array` entry, the plain encoding for an instance type, a
   `Telo.HostPath` anchored at the working directory — and validated against the same
   schema. The empty answer is the empty string.
5. **The kernel asks again** for what is still missing and for each entry whose answer it
   refused, until every input resolves or the resolver declines — by answering nothing,
   or by leaving an asked entry unanswered — and then refuses with what is still missing.
6. **An answer is never written to the environment**: not to the process environment, not
   to the kernel's snapshot of it, not to `ctx.env`, and not to the environment of an
   application it starts. A need field's answer reaches only that need's fulfilment.
7. **The refusal is unchanged**: `ERR_MANIFEST_VALIDATION_FAILED`, or the need's own
   `ERR_NEED_UNMET` / `ERR_NEED_PARTIALLY_SUPPLIED` when only needs are missing, its
   message naming no command of any host. A refusal for missing values alone — with or
   without a resolver — carries the same entries a resolver would have been handed, so a
   host can say what to supply.

## 5. Usage

`--help` answers, on standard output, a usage built only from the declarations. Nothing
is resolved, validated or started, and the process exits 0.

Its first line is `Usage: <metadata.name> <synopsis>`. The synopsis lists every binding,
flags in declaration order and then positions in order, each written as:

| Binding | Written |
|---|---|
| position | `<name>` |
| flag | `--flag <type>`, or `--flag\|-f <type>` with a short |
| boolean flag | `--[no-]flag` |

An entry with a `default:` or an `env:` may be left out, so its item is bracketed
(`[<name>]`, `[--flag <type>]`); an array-typed one repeats, so its item is followed by
`...` (`[--tag <string>]...`). The lines after it list each positional, then each flag with
its short, value type, `default:`, `env:` and its `title` or `description`. The synopsis is
the same line the documentation shows above an example's command.

Then, under `Environment:`, every `variables:`, `secrets:` and `ports:` entry — in that block
order, then declaration order — that binds `env:` and no argument (an entry with both is
listed under its argument), each as its environment variable followed by its `title` or
`description` and `[<type>; <default: …> | required; <block>.<name>]`. The type is the
entry's `x-telo-type` name, else its `type`; a port's is `tcp port` or `udp port`. A secret
is written `secret` in place of its default, with `required` when it declares none — a
secret's value is never printed.

When the application declares `needs:`, a last line names them and points at
`telo needs report`: a need's environment variables are derived from its type's fields,
which only the loaded graph knows, and `--help` resolves nothing.
