import type { MarkedVersion } from "@telorun/language-host";
import { describe, expect, it } from "vitest";

import { versionMenuRows } from "../version-menu";

const marks = (...versions: string[]): MarkedVersion[] =>
  versions.map((version) => ({ version, bundled: version.includes("+"), cached: false }));

const shown = (rows: ReturnType<typeof versionMenuRows>) =>
  rows.map((row) => `${row.nested ? "  " : ""}${row.mark.version}`);

describe("versionMenuRows", () => {
  it("lists each minor release as its newest version, the others nested beneath it", () => {
    const rows = versionMenuRows(
      marks("0.108.0", "0.108.0+unreleased", "0.107.0", "0.103.2", "0.103.1", "0.103.0", "0.102.0"),
      undefined,
    );
    expect(shown(rows)).toEqual([
      "0.108.0",
      "  0.108.0+unreleased",
      "0.107.0",
      "0.103.2",
      "  0.103.1",
      "  0.103.0",
      "0.102.0",
    ]);
  });

  it("stops at the newest minor releases, whole — a minor's patches do not count against the limit", () => {
    const rows = versionMenuRows(marks("0.5.1", "0.5.0", "0.4.0", "0.3.0", "0.2.0"), undefined, 2);
    expect(shown(rows)).toEqual(["0.5.1", "  0.5.0", "0.4.0"]);
  });

  it("still lists the minor of the selected version, however old", () => {
    const rows = versionMenuRows(marks("0.5.0", "0.4.0", "0.3.0", "0.2.1", "0.2.0"), "0.2.0", 2);
    expect(shown(rows)).toEqual(["0.5.0", "0.4.0", "0.2.1", "  0.2.0"]);
  });
});
