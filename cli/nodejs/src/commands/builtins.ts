import { BUILTIN_VOCABULARY_ARCHIVE, selectBuiltins } from "@telorun/analyzer";
import type { Argv } from "yargs";
import { outErrLine, output } from "../output.js";

/**
 * `telo builtins [<name>…]` — the built-in vocabulary of the telo this CLI is:
 * the `Telo.Builtins` archive the analyzer was built with, byte for byte, or
 * only the named entries of it (`kernel/specs/builtin-vocabulary.md`).
 *
 * The bytes are the analyzer's generated constant, never rendered here, so this
 * CLI and the Rust one print the same archive. A selection slices it
 * (`selectBuiltins`); a name selecting nothing exits 1 naming every name there
 * is. Another release's vocabulary is `telo module manifest
 * oci://ghcr.io/telorun/telo@<version>`.
 */
export function builtins(argv: { names?: string[] }): void {
  const names = argv.names ?? [];
  let text = BUILTIN_VOCABULARY_ARCHIVE;
  if (names.length > 0) {
    const selection = selectBuiltins(BUILTIN_VOCABULARY_ARCHIVE, names);
    if (!selection.ok) {
      outErrLine(selection.message);
      process.exitCode = 1;
      return;
    }
    text = selection.text;
  }
  // The document is the YAML itself; `-o json` carries the same bytes as one
  // JSON string.
  if (output().isJson) output().document(text);
  else output().raw(text);
}

export function builtinsCommand(yargs: Argv): Argv {
  return yargs.command(
    "builtins [names..]",
    "Print the built-in vocabulary of this telo — every kind, fragment, value type, zone attribute " +
      "and format a manifest uses without an import — or only the named entries",
    (y) =>
      y.positional("names", {
        describe:
          "Entries to print: a kind or need type (Application or Telo.Application), a fragment (Step), " +
          "a value type (Telo.Url), a zone attribute (atomic) or a format (css-selector)",
        type: "string",
        array: true,
      }),
    (argv) => builtins(argv as { names?: string[] }),
  );
}
