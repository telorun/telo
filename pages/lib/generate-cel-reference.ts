import fs from "node:fs";
import path from "node:path";

import { celFunctionCatalog, type CelFunctionInfo } from "@telorun/templating";

const CATEGORY_LABELS: Record<string, string> = {
  conversion: "Conversion",
  time: "Time",
  uuid: "UUID",
  string: "Strings",
  math: "Math",
  collection: "Collections",
  json: "JSON",
  encoding: "Encoding",
  hashing: "Hashing",
  null: "Null handling",
};

function tags(fn: CelFunctionInfo): string {
  const t: string[] = [];
  if (!fn.deterministic) t.push("non-deterministic");
  if (fn.hostBacked) t.push("host");
  return t.length ? ` _(${t.join(", ")})_` : "";
}

/** Render the CEL standard-library reference from the single-source catalog
 *  exported by `@telorun/templating`, so the published page can't drift from
 *  what the runtime actually registers. Mirrors `generateExamplesIndex`: runs at
 *  config load, writes a doc the sidebar picks up (and the llms-txt plugin
 *  serves the raw markdown at `/cel.md`). */
export function generateCelReference(outFile: string): void {
  const catalog = celFunctionCatalog();

  // Preserve first-appearance category order from the catalog.
  const order: string[] = [];
  const byCategory = new Map<string, CelFunctionInfo[]>();
  for (const fn of catalog) {
    if (!byCategory.has(fn.category)) {
      byCategory.set(fn.category, []);
      order.push(fn.category);
    }
    byCategory.get(fn.category)!.push(fn);
  }

  const lines: string[] = [
    "---",
    "slug: /cel",
    "---",
    "",
    "# CEL Functions",
    "",
    'Functions available in Telo CEL expressions (`!cel "..."` tags and `${{ }}`',
    "interpolations). This page is generated from the runtime registry, so it",
    "matches what the kernel actually provides. Locally, `telo cel functions`",
    'prints the same list and `telo cel eval "<expr>"` evaluates an expression.',
    "",
    "`non-deterministic` functions re-evaluate per call (in an `x-telo-eval:",
    "compile` field they bake once at load). `host` functions need the kernel's",
    "host handlers (Node `crypto` / `Buffer`).",
    "",
    "> CEL has no assignment or statements. Reuse a subexpression with the",
    "> `cel.bind(name, init, expr)` macro, and use `default(value, fallback)` /",
    "> optional access (`x.?field.orValue(d)`) where you'd reach for `??`.",
    "",
  ];

  for (const category of order) {
    lines.push(`## ${CATEGORY_LABELS[category] ?? category}`, "");
    lines.push("| Signature | Description |", "| --- | --- |");
    for (const fn of byCategory.get(category)!) {
      lines.push(`| \`${fn.signature}\` | ${fn.summary}${tags(fn)} |`);
    }
    lines.push("");
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join("\n").replace(/\n+$/, "\n"), "utf8");
}
