import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { analyzedManifests, functionListing, moduleFunctionListing } from "../src/commands/cel.js";

describe("telo cel functions <manifest>", () => {
  it("lists the functions the manifest can call, with their derived determinism", async () => {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/cel-functions/telo.yaml");
    const { manifests, registry } = await analyzedManifests(manifest);
    expect(moduleFunctionListing(manifests, registry)).toEqual([
      {
        name: "Self.withVat",
        signature: "Self.withVat(net: number) → number",
        category: "module",
        receiver: null,
        description: "Adds VAT to a net price.",
        deterministic: true,
        hostBacked: false,
        nondeterministicVia: [],
        hostBackedVia: [],
      },
      {
        name: "Self.isStale",
        signature: "Self.isStale(at: Telo.Timestamp) → boolean",
        category: "module",
        receiver: null,
        description: "Whether an instant lies more than a day in the past.",
        deterministic: false,
        hostBacked: false,
        nondeterministicVia: ["Self.isStale", "now()"],
        hostBackedVia: [],
      },
    ]);
  });
});

/**
 * Every CEL diagnostic ends with "Full list: `telo cel functions`", so this
 * listing is where a reader lands after being told a call was wrong. It used to
 * contain Telo's catalog alone — which is exactly why an author could read it
 * end to end and still call `startsWith` as a global: the built-in string
 * methods, the subject of the most common mistake, were not in it.
 */
describe("telo cel functions", () => {
  const listing = functionListing();
  const find = (signature: string) => listing.find((f) => f.signature === signature);

  it("lists Telo's own functions", () => {
    expect(find("upper(string): string")).toBeDefined();
  });

  it("lists CEL's built-ins, which the diagnostics point here for", () => {
    expect(find("string.startsWith(string): bool")).toBeDefined();
    expect(find("string.matches(string): bool")).toBeDefined();
  });

  it("says which call form a built-in takes, since that IS the mistake", () => {
    // A receiver means "call it on the value"; null means global. Without this
    // the listing shows a name and still leaves the author guessing.
    expect(find("string.startsWith(string): bool")).toMatchObject({ receiver: "string" });
    expect(find("timestamp(int): google.protobuf.Timestamp")).toMatchObject({ receiver: null });
  });

  it("keeps built-ins distinguishable without changing the catalog's shape", () => {
    // Appended under a NEW category value rather than merged into a new shape,
    // so a consumer reading `name` / `signature` is unaffected.
    expect(find("upper(string): string")!.category).not.toBe("builtin");
    expect(find("string.startsWith(string): bool")!.category).toBe("builtin");
  });
});
