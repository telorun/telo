import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import type { AliasResolver } from "../src/alias-resolver.js";
import type { DefinitionRegistry } from "../src/definition-registry.js";
import { validateModuleMetadata } from "../src/validate-module-metadata.js";

/** `Sql` is an import in scope and exports `Migrations`; `Self` names the
 *  declaring library. Anything else is unknown, so the resolution failures are
 *  reachable.
 *
 *  `Telo` reports true because the analyzer registers it as an ungated alias at
 *  every root (`registerUngatedAlias` in analyzer.ts) — a stub that denied it
 *  would let the built-in case pass through the validator's `Telo` short-circuit
 *  instead of the real resolution path, and the test would prove nothing about
 *  what actually runs. */
const aliases = {
  hasAlias: (a: string) => a === "Sql" || a === "Self" || a === "Telo",
  resolveKind: (k: string) =>
    ({
      "Sql.Migrations": "sql.Migrations",
      "Self.Migrations": "sql.Migrations",
      "Telo.JsonSchema": "Telo.JsonSchema",
    })[k],
} as unknown as AliasResolver;

const registry = {
  resolve: (k: string) => (k === "sql.Migrations" || k === "Telo.JsonSchema" ? {} : undefined),
} as unknown as DefinitionRegistry;

const library = (metadata: Record<string, unknown>): ResourceManifest =>
  ({ kind: "Telo.Library", metadata: { name: "sql", source: "file:///sql/telo.yaml", ...metadata } }) as unknown as ResourceManifest;

const definition = (metadata: Record<string, unknown>): ResourceManifest =>
  ({ kind: "Telo.Definition", metadata: { name: "Migration", source: "file:///sql/telo.yaml", ...metadata } }) as unknown as ResourceManifest;

const codes = (m: ResourceManifest[]) =>
  validateModuleMetadata(m, registry, aliases).map((d) => d.code);

describe("module metadata field types", () => {
  it("accepts the conventional block the standard library declares", () => {
    expect(
      codes([
        library({
          version: "0.9.0",
          description: "Relational storage.",
          repository: "https://github.com/telorun/telo",
          homepage: "https://telo.run/modules/sql",
          license: "LicenseRef-SustainableUse",
          categories: ["Storage"],
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps the vocabulary open for a key nothing recognizes", () => {
    expect(codes([library({ vendorSpecificThing: "anything" })])).toEqual([]);
  });

  // The reason this validator exists at all: nothing in the kernel reads these
  // fields, so a typo has no runtime failure mode and would ship unnoticed.
  it("flags a near-miss of a known field", () => {
    expect(codes([library({ licence: "MIT" })])).toEqual(["METADATA_UNKNOWN_FIELD"]);
    expect(codes([library({ deprecatd: { reason: "x" } })])).toEqual(["METADATA_UNKNOWN_FIELD"]);
  });

  it("rejects a wrong type on a known field", () => {
    expect(codes([library({ categories: "Storage" })])).toEqual(["METADATA_INVALID_TYPE"]);
  });

  // A flat edit distance of 2 accuses short, legitimate keys: `date` is two
  // edits from `name`. The vocabulary is open, so a false accusation costs more
  // than a missed typo on a four-letter key.
  it("does not call a short unrelated key a typo", () => {
    expect(codes([library({ date: "2026-08-03" })])).toEqual([]);
    expect(codes([library({ team: "platform" })])).toEqual([]);
  });

  it("still catches a typo on a longer field name", () => {
    expect(codes([library({ documentaton: "https://x" })])).toEqual(["METADATA_UNKNOWN_FIELD"]);
  });

  it("ignores the loader-stamped source key", () => {
    expect(codes([library({})])).toEqual([]);
  });
});

describe("kind-doc metadata", () => {
  // A kind's description and categories are hub inputs with exactly the failure
  // mode this validator exists for: nothing reads them, so a typo is invisible.
  it("checks a kind doc's own fields", () => {
    expect(codes([definition({ descriptoin: "Runs a migration." })])).toEqual([
      "METADATA_UNKNOWN_FIELD",
    ]);
    expect(codes([definition({ categories: "Storage" })])).toEqual(["METADATA_INVALID_TYPE"]);
  });

  it("accepts what a kind doc legitimately carries", () => {
    expect(
      codes([definition({ description: "Runs a migration.", categories: ["Storage"] })]),
    ).toEqual([]);
  });

  // `version`/`license` belong to the module; a kind restating them means
  // nothing, so they are not in the kind vocabulary — but they are far enough
  // from every kind field that they read as an unknown key, not a typo.
  it("does not invent module-only fields for a kind doc", () => {
    expect(codes([definition({ version: "1.0.0" })])).toEqual([]);
  });
});

describe("deprecation", () => {
  it("accepts a kind pointing at a sibling through Self", () => {
    expect(
      codes([definition({ deprecated: { reason: "Use the keyed map.", replacedBy: "Self.Migrations" } })]),
    ).toEqual([]);
  });

  it("accepts a kind pointing at a kernel built-in", () => {
    expect(
      codes([definition({ deprecated: { reason: "Moved into the kernel.", replacedBy: "Telo.JsonSchema" } })]),
    ).toEqual([]);
  });

  it("accepts a module pointing at another module ref, and a reason alone", () => {
    expect(
      codes([library({ deprecated: { reason: "Superseded.", replacedBy: "oci://ghcr.io/acme/thing" } })]),
    ).toEqual([]);
    expect(codes([library({ deprecated: { reason: "Moved into the kernel." } })])).toEqual([]);
  });

  it("rejects a bare boolean — it says nothing about what to do instead", () => {
    expect(codes([library({ deprecated: true })])).toEqual(["INVALID_DEPRECATION"]);
  });

  it("requires a reason", () => {
    expect(codes([definition({ deprecated: { replacedBy: "Self.Migrations" } })])).toEqual([
      "INVALID_DEPRECATION",
    ]);
    expect(codes([library({ deprecated: { reason: "   " } })])).toEqual(["INVALID_DEPRECATION"]);
  });

  it("rejects an unrecognized key inside the block", () => {
    expect(codes([library({ deprecated: { reason: "x", replacement: "y" } })])).toEqual([
      "INVALID_DEPRECATION",
    ]);
  });

  it("rejects a kind reference at module level, where a module ref belongs", () => {
    expect(codes([library({ deprecated: { reason: "x", replacedBy: "Sql.Migrations" } })])).toEqual([
      "INVALID_DEPRECATION",
    ]);
  });

  it("rejects a module ref at kind level, where an alias-qualified kind belongs", () => {
    expect(
      codes([definition({ deprecated: { reason: "x", replacedBy: "oci://ghcr.io/acme/thing" } })]),
    ).toEqual(["INVALID_DEPRECATION"]);
  });

  // A replacement a consumer cannot follow is no better than none — so the
  // alias must be in scope and the target must actually exist.
  it("rejects a replacement whose alias is not imported here", () => {
    expect(
      codes([definition({ deprecated: { reason: "x", replacedBy: "Cache.Store" } })]),
    ).toEqual(["DEPRECATION_REPLACEMENT_UNRESOLVED"]);
  });

  it("rejects a replacement naming a kind the alias does not export", () => {
    expect(
      codes([definition({ deprecated: { reason: "x", replacedBy: "Sql.Nonexistent" } })]),
    ).toEqual(["DEPRECATION_REPLACEMENT_UNRESOLVED"]);
  });

  // A library's `Self` — and every alias private to it — means nothing in a
  // consumer's scope, so re-checking a forwarded doc would report a failure
  // against a manifest the consumer does not own and cannot fix. The library's
  // own root analysis is where that belongs.
  it("skips a doc forwarded from an imported library", () => {
    const imported = [
      {
        kind: "Telo.Import",
        metadata: { name: "Other", resolvedModuleName: "other" },
      } as unknown as ResourceManifest,
      ({
        kind: "Telo.Definition",
        metadata: {
          name: "Thing",
          module: "other",
          source: "file:///other/telo.yaml",
          deprecated: { reason: "x", replacedBy: "Self.SomethingPrivate" },
        },
      }) as unknown as ResourceManifest,
    ];
    expect(codes(imported)).toEqual([]);
  });
});
