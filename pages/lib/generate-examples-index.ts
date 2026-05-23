import fs from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";

const GITHUB_BLOB_BASE = "https://github.com/telorun/telo/blob/main/examples";

interface ExampleEntry {
  file: string;
  name: string;
  description: string | null;
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
      const name = typeof metadata.name === "string" ? metadata.name : path.basename(absPath, ".yaml");
      const description =
        typeof metadata.description === "string" ? metadata.description.trim() : null;
      return { file: absPath, name, description };
    }
  }
  return null;
}

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

function renderEntry(entry: ExampleEntry, examplesRoot: string): string {
  const rel = path.relative(examplesRoot, entry.file).replace(/\\/g, "/");
  const sourceUrl = `${GITHUB_BLOB_BASE}/${rel}`;
  const lines = [`### ${entry.name}`, ""];
  if (entry.description) {
    lines.push(entry.description, "");
  }
  lines.push(`[\`${rel}\`](${sourceUrl})`, "");
  return lines.join("\n");
}

export function generateExamplesIndex(examplesRoot: string, outFile: string): void {
  const topLevel = scanDirectory(examplesRoot);

  const sections: string[] = [
    "---",
    "slug: /examples",
    "---",
    "",
    "# Examples",
    "",
    "Runnable Telo manifests showing common patterns. Each example is a complete",
    "application — clone the repo, install [`@telorun/cli`](/learn/installation-and-cli),",
    "and run `telo <file>` to execute it.",
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
      ""
    );
    for (const entry of awsLambdaEntries) {
      sections.push(renderEntry(entry, examplesRoot));
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, sections.join("\n").replace(/\n+$/, "\n"), "utf8");
}
