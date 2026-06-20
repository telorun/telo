import fs from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/telorun/telo/refs/heads/main/examples";
const GITHUB_BLOB_BASE = "https://github.com/telorun/telo/blob/main/examples";
const EDITOR_BASE = "https://editor.telo.run";

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
}

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
      return { file: absPath, name, description, envBindings };
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
  const editorUrl = `${EDITOR_BASE}/?open=${encodeURIComponent(sourceUrl)}`;
  const lines = [`### ${entry.name}`, ""];
  if (entry.description) {
    lines.push(entry.description, "");
  }
  lines.push(`\`\`\`sh title="${rel}"`);
  lines.push(`${formatEnvPrefix(entry.envBindings)}telo ${sourceUrl}`);
  lines.push(`\`\`\``);
  lines.push(
    "",
    `[Open in Telo Editor →](${editorUrl}) · [View \`${rel}\` on GitHub →](${blobUrl})`,
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

  if (topLevel.length) {
    sections.push("## Top-level", "");
    for (const entry of topLevel) {
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
