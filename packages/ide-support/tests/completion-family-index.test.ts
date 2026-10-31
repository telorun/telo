import { describe, expect, it } from "vitest";
import { buildCompletions } from "../src/completions/build.js";

const BODY = [
  "kind: Telo.Definition",
  "metadata:",
  "  name: Fleet",
  "capability: Telo.Service",
  "schema:",
  "  type: object",
  "  properties:",
  "    names: { type: array, items: { type: string } }",
  "    ports: { type: object, additionalProperties: { type: string } }",
  "resources:",
  "  - !for-each",
  "    metadata: { name: stores }",
  '    in: !cel "self.names"',
  "    as: store",
  "    emit: { kind: Self.Store }",
  "  - !for-each",
  '    in: !cel "self.names"',
  "    as: pick",
  "    emit:",
  "      !for-each",
  '      in: !cel "self.ports"',
  "      as: other",
  "      emit:",
  "        kind: Self.User",
  "        store: !ref stores[",
].join("\n");

async function complete(text: string) {
  const lines = text.split("\n");
  return buildCompletions(text, lines.length - 1, lines[lines.length - 1]!.length, undefined);
}

describe("completion inside a family reference", () => {
  it("offers only the enclosing loops iterating the family's source", async () => {
    expect((await complete(BODY)).map((c) => c.label)).toEqual(["pick"]);
  });

  it("offers the member the source keys its elements by after the dot", async () => {
    expect((await complete(`${BODY}pick.`)).map((c) => c.label)).toEqual(["index"]);
  });

  it("offers a loop whose source is spelled differently but canonically equal", async () => {
    const text = BODY.replace('in: !cel "self.names"\n    as: pick', 'in: !cel "( self.names )"\n    as: pick');
    expect((await complete(text)).map((c) => c.label)).toEqual(["pick"]);
  });

  const NESTED = [
    "kind: Telo.Definition",
    "metadata:",
    "  name: Grid",
    "capability: Telo.Service",
    "schema: { type: object }",
    "resources:",
    "  - !for-each",
    "    metadata: { name: cells }",
    '    in: !cel "self.groups"',
    "    as: g",
    "    emit:",
    "      !for-each",
    '      in: !cel "g.items"',
    "      as: c",
    "      emit: { kind: Self.Cell }",
    "  - !for-each",
    '    in: !cel "self.groups"',
    "    as: a",
    "    emit:",
    "      !for-each",
    '      in: !cel "self.groups"',
    "      as: z",
    "      emit:",
    "        !for-each",
    '        in: !cel "a.items"',
    "        as: b",
    "        emit:",
    "          !for-each",
    '          in: !cel "z.items"',
    "          as: y",
    "          emit:",
    "            kind: Self.User",
    "            cell: !ref cells[a.index][",
  ].join("\n");

  it("offers at a deeper level only a loop over the previous binding itself, not a sibling over the same source", async () => {
    expect((await complete(NESTED)).map((c) => c.label)).toEqual(["b"]);
  });
});
