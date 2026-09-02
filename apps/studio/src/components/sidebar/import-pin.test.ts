import { describe, expect, it } from "vitest";
import type { ParsedImport } from "../../model";
import { isImportPinned, upgradedImportSource } from "./import-pin";

function imp(source: string, integrity?: string): ParsedImport {
  return { name: "Timer", source, importKind: "oci", integrity, inline: true };
}

const PIN_A = `sha256-${"a".repeat(43)}`;
const PIN_B = `sha256-${"b".repeat(43)}`;

describe("isImportPinned", () => {
  it("sees a fragment pin on the source", () => {
    expect(isImportPinned(imp(`oci://ghcr.io/telorun/timer@0.3.0#${PIN_A}`))).toBe(true);
  });

  it("sees the object form's integrity sibling", () => {
    expect(isImportPinned(imp("oci://ghcr.io/telorun/timer@0.3.0", PIN_A))).toBe(true);
  });

  it("is false for an unpinned import", () => {
    expect(isImportPinned(imp("oci://ghcr.io/telorun/timer@0.3.0"))).toBe(false);
  });
});

describe("upgradedImportSource", () => {
  it("carries the target version's pin, replacing the old one", () => {
    expect(
      upgradedImportSource(imp(`oci://ghcr.io/telorun/timer@0.3.0#${PIN_A}`), {
        version: "0.4.0",
        integrity: PIN_B,
      }),
    ).toBe(`oci://ghcr.io/telorun/timer@0.4.0#${PIN_B}`);
  });

  it("pins an import that carried none", () => {
    expect(
      upgradedImportSource(imp("oci://ghcr.io/telorun/console@0.9.0"), {
        version: "0.10.0",
        integrity: PIN_B,
      }),
    ).toBe(`oci://ghcr.io/telorun/console@0.10.0#${PIN_B}`);
  });

  it("pins from the object form's sibling side too", () => {
    expect(
      upgradedImportSource(imp("oci://ghcr.io/telorun/timer@0.3.0", PIN_A), {
        version: "0.4.0",
        integrity: PIN_B,
      }),
    ).toBe(`oci://ghcr.io/telorun/timer@0.4.0#${PIN_B}`);
  });

  it("drops the stale pin when the hub publishes none for the target", () => {
    expect(
      upgradedImportSource(imp(`oci://ghcr.io/telorun/timer@0.3.0#${PIN_A}`), {
        version: "0.4.0",
      }),
    ).toBe("oci://ghcr.io/telorun/timer@0.4.0");
  });
});
