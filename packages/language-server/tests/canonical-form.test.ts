import { expect, it } from "vitest";
import { canonicalUri } from "../../language-host/src/canonical-uri.js";
import { canonicalDocumentUri } from "../src/document-uri.js";

// The host compares URIs by `canonicalUri`, the engine emits them through its
// source round trip; both must spell every location the one way the protocol
// fixes (`@telorun/editor-protocol` § URIs), or a UNC workspace never routes.
const TABLE: Array<[string, string]> = [
  ["file://ServerA/share/x", "file://servera/share/x"],
  ["file://servera/share/x", "file://servera/share/x"],
  ["file:////ServerA/share/x", "file://servera/share/x"],
  ["file://serverB/share/x", "file://serverb/share/x"],
  ["file://ServerA/share/C:/x", "file://servera/share/C%3A/x"],
  ["file://localhost/C:/a", "file:///c%3A/a"],
  ["file:///c:/a", "file:///c%3A/a"],
  ["file:///home/u/My%20Project%20(copy)/telo.yaml", "file:///home/u/My%20Project%20%28copy%29/telo.yaml"],
];

it.each([
  ["the host's", canonicalUri],
  ["the engine's", canonicalDocumentUri],
])("%s canonicaliser spells every location the protocol's one way", (who, canonical) => {
  expect(TABLE.map(([uri]) => canonical(uri))).toEqual(TABLE.map(([, expected]) => expected));
  expect(canonical("file://ServerA/share/x")).not.toBe(canonical("file://ServerB/share/x"));
});
