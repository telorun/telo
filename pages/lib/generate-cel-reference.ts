import fs from "node:fs";
import path from "node:path";

import { celBuiltinFunctions, celFunctionCatalog, type CelFunctionInfo } from "@telorun/templating";

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
    "description: Every CEL function available in a Telo manifest expression — strings, math, collections, JSON, encoding, hashing, time and UUIDs — generated from the runtime registry.",
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
    "compile` field they bake once at load, which `telo check` warns about).",
    "`host` functions need the kernel's host handlers (Node `crypto` / `Buffer`).",
    "",
    "## Call form",
    "",
    "**A signature's shape is how you must call it.** `upper(string): string` is a",
    "global function — `upper(name)`; `string.startsWith(string): bool` is a method",
    "on its receiver — `name.startsWith('x')`. Writing one as the other does not",
    "type-check, and no cast repairs it. Some names exist in both forms (`trim`,",
    "`split`, `size`, `join`), some in only one.",
    "",
    "Telo's own functions below are global. CEL's built-ins are mostly methods and",
    "are listed at the end — they were previously absent from this page entirely,",
    "which is why calling them globally was such a common mistake.",
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

  lines.push(...builtinSections());

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join("\n").replace(/\n+$/, "\n"), "utf8");
}

/** CEL's own built-ins — everything registered before Telo's catalog is added.
 *  They carry no description, category or determinism (that metadata exists
 *  only for Telo's entries), so they are listed as bare signatures grouped by
 *  receiver type. A signature carries the two facts that were missing from
 *  this page entirely: that the function exists, and how to call it. */
function builtinSections(): string[] {
  const byReceiver = new Map<string, string[]>();
  for (const fn of celBuiltinFunctions()) {
    const key = fn.receiverType ?? GLOBAL;
    const group = byReceiver.get(key);
    if (group) group.push(fn.signature);
    else byReceiver.set(key, [fn.signature]);
  }
  if (byReceiver.size === 0) return [];

  const lines = ["## CEL built-ins", "", "Provided by CEL itself, grouped by what they are called on.", ""];
  for (const receiver of [...byReceiver.keys()].sort(receiverOrder)) {
    lines.push(`### ${receiver === GLOBAL ? "Global functions" : `On \`${receiver}\``}`, "");
    for (const signature of byReceiver.get(receiver)!.sort()) lines.push(`- \`${signature}\``);
    lines.push("");
  }
  return lines;
}

/** Map key for "no receiver". A parenthesised name cannot collide with a
 *  receiver type, and unlike a control character it leaves the file text. */
const GLOBAL = "(global)";

/** Globals first, then receiver types alphabetically. */
const receiverOrder = (a: string, b: string): number =>
  a === GLOBAL ? -1 : b === GLOBAL ? 1 : a.localeCompare(b);
