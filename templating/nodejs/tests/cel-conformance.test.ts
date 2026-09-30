/**
 * The CEL conformance vectors (`templating/cel-conformance/README.md`): every row
 * of every file this runner drives is executed, and its `expect` compared whole.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCelLanguageEnvironment } from "../src/cel/environment.js";
import {
  checkLanguageRow,
  evaluateLanguageRow,
  outOfDomainType,
  runLanguageRow,
  type LanguageRow,
} from "./cel-conformance-language.js";
import { conformanceValueCodec } from "./cel-conformance-value.js";

const DIRECTORY = new URL("../../cel-conformance/", import.meta.url);
const DRIVEN = ["language.json"];
const ROW_KEYS = new Set([
  "id",
  "source",
  "provenance",
  "declarations",
  "functions",
  "bindings",
  "expect",
  "deviation",
  "divergence",
]);
const OUT_OF_DOMAIN_TYPES = ["int", "uint", "google.protobuf.Timestamp", "google.protobuf.Duration"];

interface LanguageFile {
  celSpec: { commit: string };
  rows: LanguageRow[];
}

const language = JSON.parse(readFileSync(new URL("language.json", DIRECTORY), "utf8")) as LanguageFile;
const readme = readFileSync(new URL("README.md", DIRECTORY), "utf8");
const env = buildCelLanguageEnvironment();
const codec = conformanceValueCodec(env);

/** The README's `## Divergences` table, one entry per line below its header. */
function readDivergenceTable(text: string): { id: string; nodeAnswers: string; error: string }[] {
  const section = /^## Divergences\n([\s\S]*?)(?=^## )/m.exec(text);
  if (!section) throw new Error("README.md has no '## Divergences' section");
  const lines = section[1]!.split("\n").filter((line) => line.startsWith("|"));
  if (lines[0] !== "| Row | Node answers | Error |" || lines[1] !== "| --- | --- | --- |") {
    throw new Error("README.md's divergence table does not open with its header");
  }
  return lines.slice(2).map((line) => {
    const cells = /^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    if (!cells) throw new Error(`README.md's divergence table holds a malformed line: ${line}`);
    return { id: cells[1]!, nodeAnswers: cells[2]!, error: cells[3]! };
  });
}

async function assertDivergenceRow(row: LanguageRow): Promise<void> {
  const { nodeOutOfDomain } = row.divergence!;
  expect(checkLanguageRow(env, codec, row), row.id).toStrictEqual(row.expect.check);
  const outcome = await evaluateLanguageRow(env, codec, row);
  if (!("result" in outcome)) throw new Error(`${row.id}: evaluation threw ${outcome.error.message}`);
  expect(() => codec.encode(outcome.result), row.id).toThrow(/Cannot write a conformance value/);
  expect(outOfDomainType(outcome.result), row.id).toBe(nodeOutOfDomain);
  expect(Object.keys(row.expect).sort(), row.id).toEqual(["check", "error"]);
  expect(row.expect.error!.code, row.id).toBeNull();
  const highlight = /\n\n> +(\d+) \| (.*)\n +\^$/.exec(row.expect.error!.message);
  expect(highlight, `${row.id}: the error carries no highlight`).not.toBeNull();
  expect(highlight![2], row.id).toBe(row.source.split("\n")[Number(highlight![1]) - 1]);
}

describe("CEL conformance vectors", () => {
  it("drives every file in the directory", () => {
    const files = readdirSync(DIRECTORY).filter((name) => name !== "README.md");
    expect(files.sort()).toEqual(DRIVEN);
  });

  it("reads a well-formed language file", () => {
    expect(Object.keys(language).sort()).toEqual(["celSpec", "rows"]);
    expect(Object.keys(language.celSpec)).toEqual(["commit"]);
    expect(language.celSpec.commit).toMatch(/^[0-9a-f]{40}$/);
    const ids = new Set<string>();
    for (const row of language.rows) {
      const unknown = Object.keys(row).filter((key) => !ROW_KEYS.has(key));
      expect(unknown, `row ${row.id} carries unknown keys`).toEqual([]);
      expect(row, `row ${row.id} has no expect`).toHaveProperty("expect");
      expect(ids.has(row.id), `row id ${row.id} repeats`).toBe(false);
      ids.add(row.id);
      if (row.divergence) {
        expect(Object.keys(row.divergence), row.id).toEqual(["nodeOutOfDomain"]);
        expect(OUT_OF_DOMAIN_TYPES, row.id).toContain(row.divergence.nodeOutOfDomain);
        const deviation = (row.deviation ?? {}) as { celSpec?: object; uncarried?: unknown };
        expect(Object.keys(deviation).filter((key) => key !== "celSpec" && key !== "uncarried"), row.id).toEqual([]);
        expect(Object.keys(deviation.celSpec ?? {}).filter((key) => key !== "type"), row.id).toEqual([]);
      }
    }
  });

  it("lists exactly the divergence rows in the README's table", () => {
    const listed = readDivergenceTable(readme);
    const rows = language.rows
      .filter((row) => row.divergence)
      .map((row) => ({
        id: row.id,
        nodeAnswers: row.divergence!.nodeOutOfDomain,
        error: row.expect.error!.message.split("\n")[0]!,
      }));
    expect(listed).toStrictEqual(rows);
  });

  let executed = 0;
  describe("language.json", () => {
    it.each(language.rows.map((row) => [row.id, row] as const))("%s", async (id, row) => {
      executed++;
      if (row.divergence) await assertDivergenceRow(row);
      else expect(await runLanguageRow(env, codec, row), id).toStrictEqual(row.expect);
    });
  });

  it("executed every row", () => {
    expect(executed).toBe(language.rows.length);
  });
});
