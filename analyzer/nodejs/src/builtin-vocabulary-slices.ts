/**
 * Selecting entries out of the built-in vocabulary archive by name — what
 * `telo builtins <name>…` prints, in both CLIs. Mirrored by
 * `analyzer/rust/src/builtin_vocabulary_slices.rs`, and both are held to the
 * expectation the renderer records as it emits the archive
 * (`analyzer/nodejs/builtin-vocabulary-slices.json`), so the two print the same
 * bytes for every name.
 *
 * It SLICES the archive's bytes and never re-serializes: an entry is printed as
 * the renderer wrote it. That rests on the renderer's fixed layout
 * (`kernel/specs/builtin-vocabulary.md` § Layout): documents joined by a `---`
 * line, the root first; a section of the root at column 0, each of its entries
 * at column 2 with every line of its body indented further; every later document
 * starting `kind:`, then `metadata:` with `name:` first. A name is a kind or need
 * type (`Application` or `Telo.Application`), a fragment (`Step`), a value type
 * (`Telo.Url`), a zone attribute (`atomic`), a format (`css-selector`) or an error code
 * (`ERR_INPUT_INVALID`).
 */

export type BuiltinEntryClass = "kind" | "fragment" | "value type" | "zone attribute" | "format" | "error code";

export interface BuiltinVocabularyEntry {
  readonly class: BuiltinEntryClass;
  /** Every name that selects the entry: a kind by its name with and without
   *  `Telo.`, anything else by its name alone. */
  readonly names: readonly string[];
  /** What is printed for it: a kind's whole document, or the section line and
   *  the entry's block beneath it. */
  readonly text: string;
}

const SECTION_CLASS: Readonly<Record<string, BuiltinEntryClass>> = {
  $defs: "fragment",
  valueTypes: "value type",
  zoneAttributes: "zone attribute",
  formats: "format",
  errorCodes: "error code",
};

/** The order classes are listed in when a name is unknown. */
const CLASS_ORDER: readonly BuiltinEntryClass[] = ["kind", "fragment", "value type", "zone attribute", "format", "error code"];

const DOCUMENT_SEPARATOR = "---";

function malformed(detail: string): Error {
  return new Error(`The built-in vocabulary archive is malformed: ${detail}`);
}

/** A key or scalar as the renderer writes it: plain, or a JSON string. */
function decodeScalar(text: string): string {
  if (!text.startsWith('"')) return text;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "string") return value;
  } catch {
    // reported below
  }
  throw malformed(`'${text}' is neither a plain scalar nor a JSON string.`);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Every selectable entry of `archive`, in archive order. Throws when the bytes
 *  are not in the renderer's layout. */
export function builtinVocabularyEntries(archive: string): BuiltinVocabularyEntry[] {
  if (!archive.endsWith("\n")) throw malformed("it does not end with a newline.");
  const documents: string[][] = [[]];
  for (const line of archive.slice(0, -1).split("\n")) {
    if (line === DOCUMENT_SEPARATOR) documents.push([]);
    else documents[documents.length - 1]!.push(line);
  }

  const entries: BuiltinVocabularyEntry[] = [];
  const [root, ...kinds] = documents;
  let section: string | undefined;
  let sectionLine = "";
  for (let i = 0; i < root!.length; i++) {
    const line = root![i]!;
    if (indentOf(line) === 0) {
      const header = /^(.+):$/.exec(line);
      section = header ? decodeScalar(header[1]!) : undefined;
      sectionLine = line;
      continue;
    }
    const entryClass = section === undefined ? undefined : SECTION_CLASS[section];
    if (!entryClass || indentOf(line) !== 2) continue;
    const head = /^ {2}(\S.*):$/.exec(line);
    if (!head) throw malformed(`the ${section} entry line '${line}' does not open a block.`);
    let end = i + 1;
    while (end < root!.length && indentOf(root![end]!) > 2) end++;
    if (end === i + 1) throw malformed(`the ${section} entry '${head[1]}' has an empty block.`);
    entries.push({
      class: entryClass,
      names: [decodeScalar(head[1]!)],
      text: `${[sectionLine, ...root!.slice(i, end)].join("\n")}\n`,
    });
    i = end - 1;
  }

  for (const lines of kinds) {
    if (!lines[0]?.startsWith("kind: ")) throw malformed("a document does not start with `kind:`.");
    const metadata = lines.indexOf("metadata:");
    const nameLine = metadata === -1 ? undefined : /^ {2}name: (.+)$/.exec(lines[metadata + 1] ?? "");
    if (!nameLine) throw malformed(`a document's \`metadata:\` does not start with \`name:\`.`);
    const name = decodeScalar(nameLine[1]!);
    entries.push({ class: "kind", names: [name, `Telo.${name}`], text: `${lines.join("\n")}\n` });
  }
  return entries;
}

export type BuiltinSelection =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly unknown: readonly string[]; readonly message: string };

/** The names there are, by class — what an unknown name is answered with. */
export function describeBuiltinNames(entries: readonly BuiltinVocabularyEntry[]): string {
  const lines: string[] = [];
  for (const entryClass of CLASS_ORDER) {
    const names = entries.filter((entry) => entry.class === entryClass).map((entry) => entry.names[0]!);
    if (names.length === 0) continue;
    const label = entryClass === "kind" ? "kinds (with or without 'Telo.')" : `${entryClass}s`;
    lines.push(`  ${label}: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * The text `telo builtins <names…>` prints: each name's entry, in argument
 * order, joined by `---` lines — or, when a name selects nothing, every unknown
 * name and the names there are.
 */
export function selectBuiltins(archive: string, names: readonly string[]): BuiltinSelection {
  const entries = builtinVocabularyEntries(archive);
  const byName = new Map<string, BuiltinVocabularyEntry>();
  for (const entry of entries) for (const name of entry.names) byName.set(name, entry);

  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    const quoted = unknown.map((name) => `'${name}'`).join(", ");
    return {
      ok: false,
      unknown,
      message:
        `No built-in is named ${quoted}. The names are:\n${describeBuiltinNames(entries)}`,
    };
  }
  return {
    ok: true,
    text: names.map((name) => byName.get(name)!.text).join(`${DOCUMENT_SEPARATOR}\n`),
  };
}
