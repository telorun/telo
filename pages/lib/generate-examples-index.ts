import fs from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/telorun/telo/refs/heads/main/examples";
const GITHUB_BLOB_BASE = "https://github.com/telorun/telo/blob/main/examples";
const STUDIO_BASE = "https://studio.telo.run";

interface EnvBinding {
  envKey: string;
  value: string;
}

interface ExampleEntry {
  file: string;
  name: string;
  description: string | null;
  /** Env keys bound by required `variables:` / `secrets:` on the application
   * doc, with synthesized placeholder values. Rendered as a `KEY=val …`
   * prefix on the `telo <url>` line so the docs show a runnable command. */
  envBindings: EnvBinding[];
  /** `metadata.categories`, the author-declared grouping facet. The first entry
   * is the one the example is filed under — an example touches several domains
   * but should appear once. */
  categories: string[];
}

/** Examples shown first, in this order, regardless of category. Reading order,
 * not a category: a newcomer wants "the smallest thing that runs" and then "a
 * real app" before grouping by domain is useful to them. Directory names. */
const FEATURED = ["hello-world", "todo-app", "money-transfer", "support-inbox-mcp"];

/** Heading for examples whose manifest declares no `metadata.categories`. */
const UNCATEGORIZED = "More examples";

function readExampleMetadata(absPath: string): ExampleEntry | null {
  const raw = fs.readFileSync(absPath, "utf8");
  const docs = parseAllDocuments(raw, { logLevel: "silent" });
  for (const doc of docs) {
    const value = doc.toJS();
    if (
      value &&
      typeof value === "object" &&
      typeof value.kind === "string" &&
      (value.kind === "Telo.Application" || value.kind === "Telo.Library")
    ) {
      const metadata = value.metadata ?? {};
      const name =
        typeof metadata.name === "string" ? metadata.name : path.basename(absPath, ".yaml");
      const description =
        typeof metadata.description === "string" ? metadata.description.trim() : null;
      const envBindings = [
        ...collectEnvBindings(value.variables, "variable"),
        ...collectEnvBindings(value.secrets, "secret"),
      ];
      const categories = Array.isArray(metadata.categories)
        ? metadata.categories.filter((c: unknown): c is string => typeof c === "string")
        : [];
      return { file: absPath, name, description, envBindings, categories };
    }
  }
  return null;
}

type BindingKind = "variable" | "secret";

/** Walk a `variables:` or `secrets:` block on the application/library doc and
 * pull out every entry that binds to an env var. Entries with a `default:`
 * are skipped — the manifest already has a fallback, so the docs don't need
 * to ask the reader to set them. */
function collectEnvBindings(block: unknown, kind: BindingKind): EnvBinding[] {
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const out: EnvBinding[] = [];
  for (const raw of Object.values(block as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const spec = raw as Record<string, unknown>;
    const envKey = typeof spec.env === "string" ? spec.env : null;
    if (!envKey) continue;
    if (spec.default !== undefined) continue;
    out.push({ envKey, value: placeholderValue(kind, envKey, spec) });
  }
  return out;
}

/** Pick a placeholder value for an env-bound variable/secret. Order of
 * preference: schema `examples[0]` → type-based defaults → string heuristics
 * keyed off the env name so common shapes (URLs, ports, API keys) render
 * sensibly. Secrets get clearly-fake values so the docs never imply a real
 * credential. */
function placeholderValue(
  kind: BindingKind,
  envKey: string,
  spec: Record<string, unknown>,
): string {
  const examples = Array.isArray(spec.examples) ? spec.examples : null;
  if (examples && examples.length > 0) {
    const first = examples[0];
    if (typeof first === "string" || typeof first === "number" || typeof first === "boolean") {
      return String(first);
    }
  }
  const type = typeof spec.type === "string" ? spec.type : "string";
  if (type === "integer") return "42";
  if (type === "number") return "3.14";
  if (type === "boolean") return "true";
  if (type === "object") return "{}";
  if (type === "array") return "[]";
  const key = envKey.toUpperCase();
  if (kind === "secret") {
    if (key.includes("OPENAI")) return "sk-your-openai-key";
    if (key.includes("STRIPE")) return "sk_test_your_stripe_key";
    return "your-secret-value";
  }
  if (key.includes("URL")) return "https://api.example.com";
  if (key.includes("HOST")) return "localhost";
  if (key.includes("PORT")) return "8080";
  if (key.endsWith("_KEY") || key.endsWith("_TOKEN") || key.endsWith("_ID")) {
    return "your-" + envKey.toLowerCase().replace(/_/g, "-") + "-value";
  }
  return "example-value";
}

/** Numeric and boolean literals can be left bare in `KEY=val cmd` form;
 * everything else gets single-quoted so values containing spaces, URLs with
 * `&`, JSON literals like `{}`/`[]`, etc. survive the shell unchanged. */
function shellQuote(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false") return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatEnvPrefix(bindings: ReadonlyArray<EnvBinding>): string {
  if (bindings.length === 0) return "";
  return bindings.map((b) => `${b.envKey}=${shellQuote(b.value)}`).join(" ") + " ";
}

/** Flat scan: every `*.yaml` directly inside `dir` (used for aws/lambda). */
function scanDirectory(dir: string): ExampleEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: ExampleEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".yaml")) continue;
    const abs = path.join(dir, name);
    const entry = readExampleMetadata(abs);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Each example is its own directory with a `telo.yaml` entry point
 * (`examples/<name>/telo.yaml`). Scan the immediate subdirectories and read
 * each one's `telo.yaml`. */
function scanExampleDirectories(root: string): ExampleEntry[] {
  if (!fs.existsSync(root)) return [];
  const entries: ExampleEntry[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const manifest = path.join(root, name, "telo.yaml");
    if (!fs.statSync(path.join(root, name)).isDirectory() || !fs.existsSync(manifest)) continue;
    const entry = readExampleMetadata(manifest);
    if (entry) entries.push(entry);
  }
  return entries;
}

function renderEntry(entry: ExampleEntry, examplesRoot: string): string {
  const rel = path.relative(examplesRoot, entry.file).replace(/\\/g, "/");
  const sourceUrl = `${GITHUB_RAW_BASE}/${rel}`;
  const blobUrl = `${GITHUB_BLOB_BASE}/${rel}`;
  const studioUrl = `${STUDIO_BASE}/?open=${encodeURIComponent(sourceUrl)}`;
  const lines = [`### ${entry.name}`, ""];
  if (entry.description) {
    lines.push(entry.description, "");
  }
  lines.push(`\`\`\`sh title="${rel}"`);
  lines.push(`${formatEnvPrefix(entry.envBindings)}telo ${sourceUrl}`);
  lines.push(`\`\`\``);
  lines.push(
    "",
    `[Open in Telo Studio →](${studioUrl}) · [View \`${rel}\` on GitHub →](${blobUrl})`,
  );
  return lines.join("\n");
}

export function generateExamplesIndex(examplesRoot: string, outFile: string): void {
  const topLevel = scanExampleDirectories(examplesRoot);

  const sections: string[] = [
    "---",
    "slug: /examples",
    "---",
    "",
    "# Examples",
    "",
    "Runnable Telo manifests showing common patterns. Each example is a complete",
    "application. To run an example, install [`@telorun/cli`](/learn/installation-and-cli),",
    "and run `telo <file-url>` to execute it.",
    "",
  ];

  const featured = FEATURED.map((dir) =>
    topLevel.find((e) => path.basename(path.dirname(e.file)) === dir),
  ).filter((e): e is ExampleEntry => e !== undefined);

  if (featured.length) {
    sections.push("## Start here", "");
    for (const entry of featured) {
      sections.push(renderEntry(entry, examplesRoot));
    }
  }

  // Everything else is filed under its first declared category, so each example
  // appears exactly once even though most touch several domains.
  const byCategory = new Map<string, ExampleEntry[]>();
  for (const entry of topLevel) {
    if (featured.includes(entry)) continue;
    const category = entry.categories[0] ?? UNCATEGORIZED;
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(entry);
    else byCategory.set(category, [entry]);
  }

  // Alphabetical, except the no-category bucket, which trails.
  const categories = [...byCategory.keys()]
    .filter((c) => c !== UNCATEGORIZED)
    .sort((a, b) => a.localeCompare(b));
  if (byCategory.has(UNCATEGORIZED)) categories.push(UNCATEGORIZED);

  for (const category of categories) {
    sections.push(`## ${category}`, "");
    for (const entry of byCategory.get(category)!) {
      sections.push(renderEntry(entry, examplesRoot));
    }
  }

  const awsLambdaDir = path.join(examplesRoot, "aws", "lambda");
  const awsLambdaEntries = scanDirectory(awsLambdaDir);
  if (awsLambdaEntries.length) {
    sections.push("## AWS Lambda", "");
    sections.push(
      "Lambda-specific recipes. See the [AWS Lambda example README](https://github.com/telorun/telo/blob/main/examples/aws/lambda/README.md) for the deployment walkthrough.",
      "",
    );
    for (const entry of awsLambdaEntries) {
      sections.push(renderEntry(entry, examplesRoot));
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, sections.join("\n").replace(/\n+$/, "\n"), "utf8");
}
