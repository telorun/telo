import fs from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";

/** Where the standard library is published. Modules are addressed by ref, never
 * by the directory name they happen to have in this repo. */
const OCI_BASE = "oci://ghcr.io/telorun";
const HUB = "https://hub.telo.run";

interface ModuleEntry {
  /** Directory name — also the published module name under {@link OCI_BASE}. */
  dir: string;
  categories: string[];
  summary: string;
  kinds: string[];
}

/** Row summary, from the module's `description` — which is written as hub
 * search text: one problem-first paragraph. Trimmed to a table-sized lead, cut
 * at a sentence boundary so a clause never dangles; the full text is on the hub
 * listing. Pipes are escaped, since the summary lands inside a table cell. */
const SUMMARY_BUDGET = 200;

function summarize(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  if (flat.length <= SUMMARY_BUDGET) return flat;
  const head = flat.slice(0, SUMMARY_BUDGET);
  const lastStop = head.lastIndexOf(". ");
  return lastStop === -1 ? `${head.trimEnd()}…` : head.slice(0, lastStop + 1);
}

function readModule(dir: string, manifestPath: string): ModuleEntry | null {
  const docs = parseAllDocuments(fs.readFileSync(manifestPath, "utf8"), { logLevel: "silent" });
  for (const doc of docs) {
    const value = doc.toJS();
    if (!value || typeof value !== "object" || value.kind !== "Telo.Library") continue;
    const metadata = value.metadata ?? {};
    const description = typeof metadata.description === "string" ? metadata.description : "";
    const categories = Array.isArray(metadata.categories)
      ? metadata.categories.filter((c: unknown): c is string => typeof c === "string")
      : [];
    const kinds = Array.isArray(value.exports?.kinds)
      ? value.exports.kinds.filter((k: unknown): k is string => typeof k === "string")
      : [];
    return { dir, categories, summary: summarize(description), kinds };
  }
  return null;
}

function scanModules(modulesRoot: string): ModuleEntry[] {
  const entries: ModuleEntry[] = [];
  for (const name of fs.readdirSync(modulesRoot).sort()) {
    const manifest = path.join(modulesRoot, name, "telo.yaml");
    if (!fs.existsSync(manifest)) continue;
    const entry = readModule(name, manifest);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Group by declared category. A module may declare several, so it appears in
 * each — the facet is a grouping, not a partition. */
function groupByCategory(entries: ModuleEntry[]): Map<string, ModuleEntry[]> {
  const groups = new Map<string, ModuleEntry[]>();
  for (const entry of entries) {
    const labels = entry.categories.length ? entry.categories : ["Other"];
    for (const label of labels) {
      const bucket = groups.get(label) ?? [];
      bucket.push(entry);
      groups.set(label, bucket);
    }
  }
  return new Map([...groups].sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b))));
}

function renderRow(entry: ModuleEntry): string {
  const kinds = entry.kinds.length
    ? entry.kinds.map((k) => `\`${k}\``).join(", ")
    : "—";
  const search = `${HUB}/?q=${encodeURIComponent(entry.dir)}`;
  return `| [\`${entry.dir}\`](${search}) | ${kinds} | ${entry.summary} |`;
}

export function generateStandardLibrary(modulesRoot: string, outFile: string): void {
  const entries = scanModules(modulesRoot);
  const groups = groupByCategory(entries);

  const lines: string[] = [
    "---",
    "slug: /reference/standard-library",
    'description: "The Telo standard library: what each module is for, the kinds it exports, and how to import and pin one."',
    "---",
    "",
    "# Standard library",
    "",
    "The standard library is a set of published Telo modules — the surface you",
    "import from. Nothing here is built into the kernel: each module is an",
    "ordinary artifact resolved by ref, versioned on its own, and replaceable by",
    "one of your own.",
    "",
    "This page is the map. The **authoritative reference for any kind — its full",
    `field schema, inputs and outputs — is the [hub](${HUB})**, which reads it`,
    "straight from the published manifest, so it is never out of date with the",
    "version you are importing.",
    "",
    "## Importing a module",
    "",
    "Declare it in the `imports:` map under an alias you choose, pinned to an",
    "exact version. The alias is the kind prefix everywhere in that file — a",
    "module does not dictate what you call it:",
    "",
    "```yaml",
    "imports:",
    `  Http: ${OCI_BASE}/http-server@<version>`,
    `  Db: ${OCI_BASE}/sql-sqlite@<version>`,
    "---",
    "kind: Http.Server # ← the alias you chose, not the module's directory name",
    "```",
    "",
    "`telo upgrade ./manifest.yaml` moves pins to the latest published version;",
    "`telo install ./manifest.yaml` pre-fetches everything so the run needs no",
    "network. Both are covered in the [CLI reference](/learn/installation-and-cli).",
    "",
    "An import may also carry a `#sha256-…` integrity pin, which is verified on",
    "every read — see [Security & supply chain](/deploy/security).",
    "",
    "## Finding a module",
    "",
    `- **[${HUB.replace("https://", "")}](${HUB})** — search by what a resource does, browse by`,
    "  category, and read the exact schemas of the version you are pinning.",
    '- **`telo search "<what you need>"`** — the same index from the terminal.',
    "- **MCP** — point a coding agent at the hub's MCP server so it authors",
    "  against the real schemas instead of guessing; see",
    "  [Coding agents](/build/coding-agents).",
    "",
    "## Modules by category",
    "",
    "Categories are declared by module authors, so a module appears under each",
    "one it claims. Kind names below are the suffixes — you write them as",
    "`<YourAlias>.<Kind>`.",
    "",
  ];

  for (const [label, group] of groups) {
    lines.push(`### ${label}`, "");
    lines.push("| Module | Kinds | What it's for |", "| --- | --- | --- |");
    for (const entry of group.sort((a, b) => a.dir.localeCompare(b.dir))) {
      lines.push(renderRow(entry));
    }
    lines.push("");
  }

  lines.push(
    "## Beyond the standard library",
    "",
    "The list above is what ships from the Telo repository. It is not the whole",
    "ecosystem: connectors (AWS Lambda, S3, …) and third-party modules are",
    `published from their own repositories and indexed on the [hub](${HUB})`,
    "alongside these. Any module you publish yourself is discovered the same way —",
    "see [Authoring a module](/extend/authoring-a-module).",
    "",
  );

  fs.writeFileSync(outFile, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}
