import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// `Ai.Model` and `Ai.ModelStream` declare the failures a model may raise, and a
// kind with no `throws:` of its own is read as throwing nothing — so each
// language kind here restates the whole list. This holds the restatement to the
// abstract: a code added, dropped or re-shaped on either side turns it red.

type Json = Record<string, any>;

const manifest = (relative: string): Json[] =>
  parseAllDocuments(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    logLevel: "silent",
  }).map((doc) => doc.toJS());

const declared = (docs: Json[], name: string): Json => {
  const found = docs.find((doc) => doc?.metadata?.name === name && doc.throws);
  if (!found) throw new Error(`no kind '${name}' declares throws`);
  return found;
};

/** A kind's codes with the `data` each declares, descriptions set aside: prose
 *  may differ per provider, the shape may not. */
const failures = (kind: Json): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(kind.throws.codes as Record<string, Json>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, entry]) => [code, withoutDescriptions(entry.data ?? null)]),
  );

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, inner]) => [key, withoutDescriptions(inner)]),
  );
}

const ai = manifest("../../../ai/telo.yaml");
const own = manifest("../../telo.yaml");

describe("the failure list each language kind restates", () => {
  it.each([
    ["MessagesModel", "Model"],
    ["MessagesModelStream", "ModelStream"],
  ])("%s declares exactly Ai.%s's codes and data", (kind, abstract) => {
    const restated = declared(own, kind);
    expect(restated.extends).toBe(`Ai.${abstract}`);
    expect(restated.throws).toEqual({ codes: restated.throws.codes });
    expect(failures(restated)).toEqual(failures(declared(ai, abstract)));
  });
});
