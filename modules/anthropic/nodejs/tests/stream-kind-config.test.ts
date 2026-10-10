import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// The two kinds are one model reached two ways, so they take one configuration:
// the same fields, the same required ones, and the same keys refused in
// `options`. Only what the prose says about them may differ.

type Json = Record<string, any>;

const kinds: Json[] = parseAllDocuments(
  readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"),
  { logLevel: "silent" },
).map((doc) => doc.toJS());

const schemaOf = (name: string): Json => {
  const kind = kinds.find((doc) => doc?.kind === "Telo.Definition" && doc.metadata?.name === name);
  if (!kind) throw new Error(`no kind '${name}'`);
  return withoutProse(kind.schema) as Json;
};

function withoutProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description" && key !== "title")
      .map(([key, inner]) => [key, withoutProse(inner)]),
  );
}

it("MessagesModelStream takes exactly MessagesModel's configuration", () => {
  const stream = schemaOf("MessagesModelStream");
  expect(stream).toEqual(schemaOf("MessagesModel"));
  expect(Object.keys(stream.properties.options.properties).sort()).toEqual(
    ["maxTokens", "max_tokens", "messages", "model", "stream", "system", "toolChoice", "tool_choice", "tools"],
  );
});
