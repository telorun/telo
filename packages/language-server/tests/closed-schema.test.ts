import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { closedProjection } from "./closed-schema.js";

const published = JSON.parse(
  readFileSync(new URL("../node_modules/@telorun/editor-protocol/editor-protocol-schema.json", import.meta.url), "utf8"),
);

// A later addition within generation 1 validates against what hosts read; the
// engine of this generation must not send it, which the projection catches.
it("admits an unknown member and enum value that its closed projection refuses", () => {
  const entry = `${published.$id}#/$defs/DirectoryEntry`;
  const later = { name: "x", kind: "socket", mode: 420 };
  const open = new Ajv({ strict: false });
  open.addSchema(published);
  const closed = new Ajv({ strict: false });
  closed.addSchema(closedProjection(published));
  expect(open.getSchema(entry)!(later)).toBe(true);
  expect(closed.getSchema(entry)!(later)).toBe(false);
  expect(closed.getSchema(entry)!({ name: "x", kind: "symlink" })).toBe(true);
});
