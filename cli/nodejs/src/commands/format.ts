import { formatManifestText, isManifestText } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";
import type { Argv } from "yargs";
import { selectByPatterns } from "@telorun/glob";
import { EXIT_REFUSED } from "../exit-status.js";
import { outErrLine, output } from "../output.js";

/** Directories a search never enters; a file named explicitly inside one is still formatted. */
const SEARCH_SKIPPED_DIRS = new Set(["node_modules", "dist", ".git", ".telo", "__fixtures__"]);

const GLOB_CHARS = /[*?]/;

interface FormatFailure {
  file: string;
  message: string;
  line?: number;
  column?: number;
}

async function walkYaml(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SEARCH_SKIPPED_DIRS.has(entry.name)) found.push(...(await walkYaml(full)));
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

interface Selection {
  /** Found by a directory or glob search: a non-manifest is skipped quietly. */
  searched: Set<string>;
  /** Named as a file: a non-manifest is refused. */
  named: Set<string>;
  missing: string[];
}

async function select(inputs: string[]): Promise<Selection> {
  const selection: Selection = { searched: new Set(), named: new Set(), missing: [] };
  for (const input of inputs) {
    if (GLOB_CHARS.test(input)) {
      const all = (await walkYaml(process.cwd())).map((f) =>
        path.relative(process.cwd(), f).split(path.sep).join("/"),
      );
      for (const rel of selectByPatterns(all, [input])) {
        selection.searched.add(path.resolve(process.cwd(), rel));
      }
      continue;
    }
    const resolved = path.resolve(process.cwd(), input);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) selection.missing.push(input);
    else if (stat.isDirectory()) {
      for (const file of await walkYaml(resolved)) selection.searched.add(file);
    } else selection.named.add(resolved);
  }
  return selection;
}

export async function format(argv: { paths?: string[]; check?: boolean }): Promise<void> {
  const check = argv.check === true;
  const inputs = argv.paths && argv.paths.length > 0 ? argv.paths : ["."];
  const out = output();
  const rel = (file: string) => path.relative(process.cwd(), file) || file;

  const selection = await select(inputs);
  const changed: string[] = [];
  const failures: FormatFailure[] = [];
  let unchanged = 0;
  let skipped = 0;

  for (const input of selection.missing) {
    failures.push({ file: input, message: "no such file or directory" });
    outErrLine(`✗  ${input}: no such file or directory`);
  }

  const files = [...new Set([...selection.named, ...selection.searched])].sort();
  for (const file of files) {
    const text = await fs.readFile(file, "utf-8");
    if (!isManifestText(text)) {
      if (selection.named.has(file)) {
        failures.push({ file: rel(file), message: "not a Telo manifest" });
        outErrLine(
          `✗  ${rel(file)}: not a Telo manifest — its first document has no dotted \`kind\` (for example \`Telo.Application\`)`,
        );
      } else skipped++;
      continue;
    }
    const result = formatManifestText(text);
    if (!result.ok) {
      const { line, column, message } = result.error;
      failures.push({ file: rel(file), message, line, column });
      outErrLine(`✗  ${rel(file)}:${line}:${column}: ${message}`);
      continue;
    }
    if (!result.changed) {
      unchanged++;
      continue;
    }
    changed.push(rel(file));
    if (!check) await fs.writeFile(file, result.text, "utf-8");
    out.line(`${check ? "would format" : "formatted"}  ${rel(file)}`);
  }

  if (failures.length === 0 && changed.length === 0) out.line("Nothing to format");
  else if (changed.length > 0) {
    out.line(
      `\n${changed.length} file${changed.length === 1 ? "" : "s"} ${check ? "would change" : "formatted"}.`,
    );
  }

  out.emit({
    ok: failures.length === 0 && !(check && changed.length > 0),
    check,
    changed,
    unchanged,
    skipped,
    failures,
  });

  if (failures.length > 0) process.exitCode = EXIT_REFUSED;
  else if (check && changed.length > 0) process.exitCode = 1;
}

export function formatCommand(yargs: Argv): Argv {
  return yargs.command(
    "format [paths..]",
    "Rewrite manifests to the canonical layout (flow style for short leaves)",
    (y) =>
      y
        .positional("paths", {
          describe: "Files, directories or globs; defaults to the current directory",
          type: "string",
          array: true,
        })
        .option("check", {
          describe: "Write nothing; exit 1 when any file would change",
          type: "boolean",
          default: false,
        }),
    async (argv) => {
      await format(argv as any);
    },
  );
}
