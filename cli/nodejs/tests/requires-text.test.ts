import { describe, expect, it } from "vitest";
import { measurementCopy, writeFloor } from "../src/release/requires-text.js";

const BLOCK = `kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.0
requires:
  telo: ">=0.80.0" # the floor
  host: { node: ">=20.0.0" }
exports:
  kinds: [Lookup]
`;

describe("writeFloor", () => {
  it("replaces the scalar in place, keeping comments and quote style", () => {
    expect(writeFloor(BLOCK, "0.115.0").text).toBe(
      BLOCK.replace('">=0.80.0" # the floor', '">=0.115.0" # the floor'),
    );
  });

  it("inserts a flow-style requires block after metadata when there is none", () => {
    const text = "kind: Telo.Library\nmetadata:\n  name: A\n  version: 1.0.0\nexports:\n  kinds: []\n";
    const edit = writeFloor(text, "unreleased");
    expect(edit.text).toBe(
      "kind: Telo.Library\nmetadata:\n  name: A\n  version: 1.0.0\nrequires: { telo: \">=unreleased\" }\nexports:\n  kinds: []\n",
    );
    expect(edit.delta).toBe(1);
  });

  it("adds telo beside the host bound of an existing block", () => {
    const text = BLOCK.replace('  telo: ">=0.80.0" # the floor\n', "");
    expect(writeFloor(text, "0.90.0").text).toBe(
      text.replace("  host:", '  telo: ">=0.90.0"\n  host:'),
    );
  });

  it("removes telo and leaves the rest of the block, or the whole block when it was alone", () => {
    expect(writeFloor(BLOCK, null).text).toBe(BLOCK.replace('  telo: ">=0.80.0" # the floor\n', ""));
    const alone = BLOCK.replace('  host: { node: ">=20.0.0" }\n', "");
    expect(writeFloor(alone, null).text).toBe(alone.replace('requires:\n  telo: ">=0.80.0" # the floor\n', ""));
  });

  it("edits a flow-style block", () => {
    const text = 'kind: Telo.Library\nmetadata: { name: A, version: 1.0.0 }\nrequires: { telo: ">=0.80.0", host: { node: ">=20.0.0" } }\n';
    expect(writeFloor(text, null).text).toContain('requires: { host: { node: ">=20.0.0" } }');
  });
});

describe("measurementCopy", () => {
  const WITH_ENTRIES = `${BLOCK}restrictions:
  - versions: ">=1.2.0"
    requires: { telo: "<0.122.0", host: { node: "<24.0.0" } }
    reason: Broken above.
`;

  it("puts the candidate floor in place and replaces every bound inside an entry, keeping its keys", () => {
    const copy = measurementCopy(WITH_ENTRIES, "0.100.0").text;
    expect(copy).toContain('telo: ">=0.100.0" # the floor');
    expect(copy).toContain(
      'requires: { telo: ">=0.100.0", host: { node: ">=0.0.0" } }\n    reason: Broken above.',
    );
    expect(copy).toContain('versions: ">=1.2.0"');
  });

  it("measures with no floor: the module's telo bound is gone and an entry's telo bound is met by any runtime", () => {
    const copy = measurementCopy(WITH_ENTRIES, null).text;
    expect(copy).not.toContain('telo: ">=0.80.0"');
    expect(copy).toContain('requires: { telo: ">=0.0.0", host: { node: ">=0.0.0" } }');
  });
});
