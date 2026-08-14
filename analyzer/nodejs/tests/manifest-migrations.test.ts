import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags, isTaggedSentinel } from "@telorun/templating";
import { Loader } from "../src/manifest-loader.js";
import { parseLoadedFile } from "../src/parse-loaded-file.js";
import { migrateFileText } from "../src/migrations/driver.js";
import { parseMigrationEntry } from "../src/migrations/entry-data.js";
import { remapMigratedPaths } from "../src/migrations/provenance.js";
import { CORE_MIGRATIONS } from "../src/migrations/registry.js";
import { validateAgainstSchema } from "../src/schema-compat.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";
import type { MigrationEntry } from "../src/migrations/types.js";

/** Containment shared by the driver tests: every fixture below is a
 *  `Telo.Application`, and these are the top-level keys its bodies use. Real
 *  entries name a much narrower region — see `analyzer/migrations/`. */
const TEST_SCOPE = {
  inKind: ["Telo.Application", "Telo.Library", "Telo.Definition"],
  under: ["schema", "targets", "metadata", "value", "legacy", "x-brand"],
} as const;

/** In-memory ManifestSource backed by a flat path → text map. */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      if (relative.startsWith("/")) return relative;
      const baseDir = base.slice(0, base.lastIndexOf("/") + 1);
      const parts = (baseDir + relative).split("/");
      const out: string[] = [];
      for (const p of parts) {
        if (p === "" && out.length === 0) {
          out.push("");
          continue;
        }
        if (p === "" || p === ".") continue;
        if (p === "..") {
          if (out.length > 1) out.pop();
          continue;
        }
        out.push(p);
      }
      let resolved = out.join("/");
      if (!/\.[^/]+$/.test(resolved)) resolved += "/telo.yaml";
      return resolved;
    },
  };
}

const renameEntry: MigrationEntry = {
  id: "test-rename",
  code: "TEST_DEPRECATED",
  severity: DiagnosticSeverity.Warning,
  reason: "The old key was unified into the new one.",
  rules: [
    {
      match: { key: "x-old-flag", ...TEST_SCOPE },
      patch: [
        { op: "rename-key", to: "x-new-type" },
        { op: "set-value", value: "Telo.Stream" },
      ],
    },
  ],
};

const qualifyEntry: MigrationEntry = {
  id: "test-qualify",
  code: "TEST_UNQUALIFIED",
  severity: DiagnosticSeverity.Warning,
  reason: "Names are alias-qualified.",
  rules: [
    {
      match: { key: "x-brand", ...TEST_SCOPE },
      patch: [{ op: "set-value", qualify: "Telo." }],
    },
  ],
};

const app = (body: string) =>
  ["kind: Telo.Application", "metadata:", "  name: app", body].join("\n") + "\n";

describe("migration driver — tree rewrite", () => {
  it("rewrites the legacy spelling and reports the author's path", () => {
    const text = app(["schema:", "  properties:", "    out:", "      x-old-flag: true"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry],
    });

    const schema = (file.manifests[0] as any).schema.properties.out;
    expect(schema).toEqual({ "x-new-type": "Telo.Stream" });

    expect(file.migrations.rewrites).toHaveLength(1);
    const rewrite = file.migrations.rewrites[0]!;
    expect(rewrite.legacyPath).toBe("schema.properties.out.x-old-flag");
    expect(rewrite.migratedPath).toBe("schema.properties.out.x-new-type");
    expect(rewrite.entryId).toBe("test-rename");

    const diagnostic = file.migrations.diagnostics[0]!;
    expect(diagnostic.code).toBe("TEST_DEPRECATED");
    expect((diagnostic.data as any).path).toBe("schema.properties.out.x-old-flag");
    expect(diagnostic.message).toContain("`x-old-flag: true` is now written `x-new-type: Telo.Stream`.");
    expect(diagnostic.message).toContain("The old key was unified into the new one.");
  });

  it("leaves the tree untouched when the load does not opt in", () => {
    const text = app(["schema:", "  x-old-flag: true"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrations: [renameEntry],
    });
    expect((file.manifests[0] as any).schema).toEqual({ "x-old-flag": true });
    expect(file.migrations.rewrites).toHaveLength(0);
  });

  it("is idempotent — a second pass matches nothing", () => {
    const text = app(["schema:", "  x-old-flag: true"].join("\n"));
    const once = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry],
    });
    expect(once.migrations.rewrites).toHaveLength(1);

    // Re-running over the already-migrated tree finds nothing, because a rule
    // matches only the legacy spelling.
    const twice = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: once.manifests,
      entries: [renameEntry],
    });
    expect(twice).toBeNull();
  });

  it("refuses a rename whose destination is occupied and leaves the node alone", () => {
    const text = app(["schema:", "  x-old-flag: true", "  x-new-type: Telo.Bytes"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry],
    });
    expect((file.manifests[0] as any).schema).toEqual({
      "x-old-flag": true,
      "x-new-type": "Telo.Bytes",
    });
    expect(file.migrations.rewrites).toHaveLength(0);
  });

  it("keeps the renamed key in its original position", () => {
    const text = app(["schema:", "  a: 1", "  x-old-flag: true", "  z: 2"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry],
    });
    expect(Object.keys((file.manifests[0] as any).schema)).toEqual(["a", "x-new-type", "z"]);
  });

  it("refuses a match under an array a sibling patch resized", () => {
    // A frozen match reaches through a sequence by INDEX, and an index is not
    // an identity: after the insert every element shifted, so `targets[1].label`
    // now names the element that used to be `targets[0]`. Rewriting it would
    // edit the wrong node silently, so both matches are refused.
    const inserter: MigrationEntry = {
      ...qualifyEntry,
      id: "test-insert-first",
      rules: [
        { match: { key: "targets", ...TEST_SCOPE }, patch: [{ op: "insert-item", value: "inserted", at: 0 }] },
      ],
    };
    const indexed: MigrationEntry = {
      ...qualifyEntry,
      id: "test-indexed",
      rules: [{ match: { key: "label", ...TEST_SCOPE }, patch: [{ op: "set-value", value: "REWRITTEN" }] }],
    };
    const text = app(["targets:", "  - label: a", "  - label: b"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [inserter, indexed],
    });
    expect((file.manifests[0] as any).targets).toEqual([
      "inserted",
      { label: "a" },
      { label: "b" },
    ]);
    expect(file.migrations.rewrites.map((r) => r.entryId)).toEqual(["test-insert-first"]);
  });

  it("freezes the match set, so no rule sees another rule's output", () => {
    // `renameEntry` produces `x-new-type`; a second entry matching that key
    // must not fire on the value the first one wrote.
    const producedKey: MigrationEntry = {
      ...qualifyEntry,
      id: "test-follow-on",
      rules: [{ match: { key: "x-new-type", ...TEST_SCOPE }, patch: [{ op: "set-value", value: "SEEN" }] }],
    };
    const text = app(["schema:", "  x-old-flag: true"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry, producedKey],
    });
    expect((file.manifests[0] as any).schema).toEqual({ "x-new-type": "Telo.Stream" });
  });
});

describe("containment", () => {
  it("does not reach a key of the same name inside a nested resource's config", () => {
    // `under` is anchored at the document root. A `Telo.Definition`'s template
    // body carries other kinds' configuration, and any of it may hold a mapping
    // spelled like the region a rule names over data that merely LOOKS like a
    // schema. Matching "some segment of the path" would delete from it silently
    // — the exact corruption positive containment exists to prevent.
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-anchored",
      rules: [
        {
          match: { key: "type", inKind: ["Telo.Definition"], under: ["schema"], value: "string" },
          patch: [{ op: "remove-entry" }],
        },
      ],
    };
    const text = [
      "kind: Telo.Definition",
      "metadata:",
      "  name: Thing",
      "capability: Telo.Invocable",
      "schema:",
      "  properties:",
      "    reached:",
      "      type: string",
      "resources:",
      "  - kind: Assert.Equals",
      "    metadata:",
      "      name: inner",
      "    expected:",
      "      schema:",
      "        type: string",
      "",
    ].join("\n");
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [entry],
    });
    expect(file.migrations.rewrites.map((r) => r.legacyPath)).toEqual([
      "schema.properties.reached.type",
    ]);
    // The author's data, untouched.
    expect((file.manifests[0] as any).resources[0].expected.schema).toEqual({ type: "string" });
  });

  it("does not walk a document no rule targets", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-kind-gate",
      rules: [
        {
          match: { key: "x-brand", inKind: ["Telo.Definition"], under: ["schema"] },
          patch: [{ op: "set-value", qualify: "Telo." }],
        },
      ],
    };
    const file = parseLoadedFile(
      "/ws/telo.yaml",
      "/ws/telo.yaml",
      app(["schema:", "  x-brand: TcpPort"].join("\n")),
      { migrate: true, migrations: [entry] },
    );
    expect(file.migrations.rewrites).toHaveLength(0);
    expect((file.manifests[0] as any).schema["x-brand"]).toBe("TcpPort");
  });
});

describe("quick fix derivation", () => {
  it("derives a fix from a lone set-value", () => {
    const text = app(["schema:", "  x-brand: TcpPort"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [qualifyEntry],
    });
    expect((file.manifests[0] as any).schema).toEqual({ "x-brand": "Telo.TcpPort" });
    const diagnostic = file.migrations.diagnostics[0]!;
    expect((diagnostic.data as any).fix).toEqual({ replacement: "Telo.TcpPort" });
    expect(diagnostic.message).toContain("Run `telo migrate` to apply it.");
  });

  it("refuses a qualify whose value is already current", () => {
    const text = app(["schema:", "  x-brand: Telo.TcpPort"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [qualifyEntry],
    });
    expect(file.migrations.rewrites).toHaveLength(0);
    expect(file.migrations.diagnostics).toHaveLength(0);
  });

  it("refuses a literal set-value whose value is already current", () => {
    // Same refusal as `qualify`'s: a rule should match only the legacy
    // spelling, so writing the value already there means the matcher was too
    // wide — and reporting it would read `x-brand: Telo.Stream is now written
    // x-brand: Telo.Stream`.
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-noop",
      rules: [
        {
          match: { key: "x-brand", ...TEST_SCOPE, valueOneOf: ["Stream", "Telo.Stream"] },
          patch: [{ op: "set-value", value: "Telo.Stream" }],
        },
      ],
    };
    const already = parseLoadedFile(
      "/ws/telo.yaml",
      "/ws/telo.yaml",
      app(["schema:", "  x-brand: Telo.Stream"].join("\n")),
      { migrate: true, migrations: [entry] },
    );
    expect(already.migrations.rewrites).toHaveLength(0);

    const legacy = parseLoadedFile(
      "/ws/telo.yaml",
      "/ws/telo.yaml",
      app(["schema:", "  x-brand: Stream"].join("\n")),
      { migrate: true, migrations: [entry] },
    );
    expect(legacy.migrations.rewrites).toHaveLength(1);
  });

  it("offers no fix for a patch containing a rename, and says why", () => {
    const text = app(["schema:", "  x-old-flag: true"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, {
      migrate: true,
      migrations: [renameEntry],
    });
    const diagnostic = file.migrations.diagnostics[0]!;
    expect((diagnostic.data as any).fix).toBeUndefined();
    expect(diagnostic.message).toContain("no quick fix (renames a key) — run `telo migrate`");
  });
});

describe("operation vocabulary", () => {
  const run = (body: string, entry: MigrationEntry) =>
    parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", app(body), {
      migrate: true,
      migrations: [entry],
    });

  it("set-tag puts a scalar behind a templating tag", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-tag",
      rules: [{ match: { key: "value", ...TEST_SCOPE }, patch: [{ op: "set-tag", tag: "cel" }] }],
    };
    const file = run(["value: variables.port"].join("\n"), entry);
    const tagged = (file.manifests[0] as any).value;
    expect(isTaggedSentinel(tagged)).toBe(true);
    expect(tagged.engine).toBe("cel");
    expect(tagged.source).toBe("variables.port");
  });

  it("insert-item appends to a sequence", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-insert",
      rules: [{ match: { key: "targets", ...TEST_SCOPE }, patch: [{ op: "insert-item", value: "extra" }] }],
    };
    const file = run(["targets:", "  - main"].join("\n"), entry);
    expect((file.manifests[0] as any).targets).toEqual(["main", "extra"]);
  });

  it("remove-entry drops a mapping entry", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-remove",
      rules: [{ match: { key: "legacy", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }],
    };
    const file = run(["legacy: gone", "kept: yes"].join("\n"), entry);
    expect((file.manifests[0] as any).legacy).toBeUndefined();
    expect((file.manifests[0] as any).kept).toBe("yes");
    expect(file.migrations.diagnostics[0]!.message).toContain("`legacy` is no longer used.");
  });

  it("refuses an operation whose target has the wrong shape", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-shape",
      rules: [{ match: { key: "targets", ...TEST_SCOPE }, patch: [{ op: "insert-item", value: "extra" }] }],
    };
    const file = run(["targets: main"].join("\n"), entry);
    expect((file.manifests[0] as any).targets).toBe("main");
    expect(file.migrations.rewrites).toHaveLength(0);
  });
});

describe("migrateFileText — the file repair", () => {
  it("edits only the matched bytes, preserving comments and quote style", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "schema:",
      "  # keep me",
      "  out:",
      "    x-old-flag: true   # trailing",
      "  note: |",
      "    a block scalar",
      "    stays folded",
      "",
    ].join("\n");
    const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);

    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents,
      manifests: parsed.manifests,
      entries: [renameEntry],
    });

    expect(migrated).not.toBeNull();
    expect(migrated!.text).toContain("x-new-type: Telo.Stream   # trailing");
    expect(migrated!.text).toContain("  # keep me");
    expect(migrated!.text).toContain("  note: |\n    a block scalar\n    stays folded\n");
    expect(migrated!.rewrites).toHaveLength(1);
  });

  it("keeps the author's quote style when replacing a value", () => {
    const text = ["kind: Telo.Application", "metadata:", "  name: app", "x-brand: 'TcpPort'"].join(
      "\n",
    );
    const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents,
      manifests: parsed.manifests,
      entries: [qualifyEntry],
    });
    expect(migrated!.text).toContain("x-brand: 'Telo.TcpPort'");
  });

  it("returns null when nothing matched", () => {
    const text = ["kind: Telo.Application", "metadata:", "  name: app", "other: 1"].join("\n");
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text).manifests,
      entries: [renameEntry],
    });
    expect(migrated).toBeNull();
  });

  it("writes a tag in front of the value the same patch produced", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-tag-then-value",
      rules: [
        {
          match: { key: "value", ...TEST_SCOPE },
          patch: [
            { op: "set-value", value: "variables.port + 1" },
            { op: "set-tag", tag: "cel" },
          ],
        },
      ],
    };
    const text = ["kind: Telo.Application", "metadata:", "  name: app", "value: old"].join("\n");
    const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents,
      manifests: parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text).manifests,
      entries: [entry],
    });
    // Quoting follows the author's original style, so a plain scalar stays
    // plain — `renderScalar` promotes only what could not survive unquoted.
    expect(migrated!.text).toContain("value: !cel variables.port + 1");
  });

  it("removes an entry's whole line", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-remove-text",
      rules: [{ match: { key: "legacy", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }],
    };
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "legacy: gone",
      "kept: yes",
      "",
    ].join("\n");
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text).manifests,
      entries: [entry],
    });
    expect(migrated!.text).not.toContain("legacy");
    expect(migrated!.text).toContain("kept: yes");
  });

  it("inserts a sequence item at the list's indentation", () => {
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-insert-text",
      rules: [{ match: { key: "targets", ...TEST_SCOPE }, patch: [{ op: "insert-item", value: "extra" }] }],
    };
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "targets:",
      "  - main",
      "",
    ].join("\n");
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text).manifests,
      entries: [entry],
    });
    expect(migrated!.text).toContain("targets:\n  - main\n  - extra\n");
  });

  it("removes a mapping entry that opens a sequence item", () => {
    // The dominant real-world shape of the only shipped entry: a legacy ref
    // slot is almost always an `anyOf` branch, written `- type: string` with
    // the annotation beneath. Deleting the line would take the `- ` with it and
    // fold the branch into its predecessor, so the following key slides onto
    // the dash instead. Refusing would have made the diagnostic's own advice
    // dead for the case it is most often given in.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "schema:",
      "  anyOf:",
      "    - legacy: gone",
      "      x-telo-ref: 'telo#Runnable'",
      "    - legacy: gone",
      "      x-telo-ref: 'telo#Service'",
      "",
    ].join("\n");
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-remove-branch",
      rules: [{ match: { key: "legacy", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }],
    };
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parsed.manifests,
      entries: [entry],
    });
    expect(migrated!.unwritable).toEqual([]);
    expect(migrated!.text).toBe(
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "schema:",
        "  anyOf:",
        "    - x-telo-ref: 'telo#Runnable'",
        "    - x-telo-ref: 'telo#Service'",
        "",
      ].join("\n"),
    );
    // …and the repaired file reparses to the tree the in-memory rewrite produced.
    expect(
      (parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", migrated!.text).manifests[0] as any).schema,
    ).toEqual({
      anyOf: [{ "x-telo-ref": "telo#Runnable" }, { "x-telo-ref": "telo#Service" }],
    });
  });

  it("refuses to remove the sole entry of a sequence item", () => {
    // Nothing to promote onto the dash — `- ` with no value is not the mapping
    // the author had, so this stays a hand edit.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "schema:",
      "  anyOf:",
      "    - legacy: gone",
      "",
    ].join("\n");
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-remove-sole",
      rules: [{ match: { key: "legacy", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }],
    };
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parsed.manifests,
      entries: [entry],
    });
    expect(migrated!.rewrites).toEqual([]);
    expect(migrated!.unwritable).toHaveLength(1);
  });

  it("refuses when a comment sits between the entry and its successor", () => {
    // The splice would swallow it, and destroying an author's comment is not a
    // repair.
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "schema:",
      "  anyOf:",
      "    - legacy: gone",
      "      # why this branch exists",
      "      x-telo-ref: 'telo#Runnable'",
      "",
    ].join("\n");
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-remove-comment",
      rules: [{ match: { key: "legacy", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }],
    };
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parsed.manifests,
      entries: [entry],
    });
    expect(migrated!.unwritable).toHaveLength(1);
    expect(migrated!.text).toContain("# why this branch exists");
  });

  it("reports a rewrite the text cannot express instead of silently skipping it", () => {
    // A flow-style sequence has no item line to extend, so the insert is
    // refused rather than written into a shape it would corrupt — and REPORTED,
    // because the diagnostic that sends an author here says to run this.
    const entry: MigrationEntry = {
      ...qualifyEntry,
      id: "test-flow-refusal",
      rules: [{ match: { key: "targets", ...TEST_SCOPE }, patch: [{ op: "insert-item", value: "extra" }] }],
    };
    const text = ["kind: Telo.Application", "metadata:", "  name: app", "targets: [main]"].join(
      "\n",
    );
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents: parseAllDocuments(text, { customTags: defaultCustomTags() }),
      manifests: parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text).manifests,
      entries: [entry],
    });
    expect(migrated!.text).toBe(text);
    expect(migrated!.rewrites).toHaveLength(0);
    expect(migrated!.unwritable).toHaveLength(1);
    expect(migrated!.unwritable[0]!.legacyPath).toBe("targets");
  });

  it("edits every document of a multi-document file", () => {
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Thing",
      "schema:",
      "  x-old-flag: true",
      "",
    ].join("\n");
    const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
    const parsed = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    const migrated = migrateFileText({
      source: "/ws/telo.yaml",
      text,
      documents,
      manifests: parsed.manifests,
      entries: [renameEntry],
    });
    expect(migrated!.text).toContain("  x-new-type: Telo.Stream");
    expect(migrated!.text).toContain("kind: Telo.Application");
  });
});

describe("path provenance", () => {
  it("remaps a downstream diagnostic back onto the author's path", async () => {
    const files = {
      "/ws/telo.yaml": app(["schema:", "  properties:", "    out:", "      x-old-flag: true"].join("\n")),
    };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });
    const graph = await loader.loadGraph("/ws/telo.yaml", {
      desugarImports: true,
      migrate: true,
    });

    const downstream = {
      message: "something about the migrated node",
      data: {
        resource: { kind: "Telo.Application", name: "app" },
        path: "schema.properties.out.x-new-type",
      },
    };
    const [remapped] = remapMigratedPaths(graph, [downstream]);
    expect((remapped!.data as any).path).toBe("schema.properties.out.x-old-flag");
  });

  it("remaps a diagnostic that names only its file", async () => {
    // A diagnostic carries at most two routing facts and routinely only one:
    // plenty of analyzer diagnostics carry `filePath` and `path` with no
    // `resource`, and a rewrite in a document with no `metadata.name` (every
    // `Telo.Import`) has no identity to be indexed under. Routing by identity
    // alone left both simply unreachable.
    const files = {
      "/ws/telo.yaml": app(["schema:", "  properties:", "    out:", "      x-old-flag: true"].join("\n")),
    };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });
    const graph = await loader.loadGraph("/ws/telo.yaml", {
      desugarImports: true,
      migrate: true,
    });

    const [remapped] = remapMigratedPaths(graph, [
      {
        message: "a module-level finding",
        data: { filePath: "/ws/telo.yaml", path: "schema.properties.out.x-new-type" },
      },
    ]);
    expect((remapped!.data as any).path).toBe("schema.properties.out.x-old-flag");
  });

  it("leaves a path alone when it names neither a file nor a resource", async () => {
    const files = {
      "/ws/telo.yaml": app(["schema:", "  properties:", "    out:", "      x-old-flag: true"].join("\n")),
    };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });
    const graph = await loader.loadGraph("/ws/telo.yaml", {
      desugarImports: true,
      migrate: true,
    });

    const [remapped] = remapMigratedPaths(graph, [
      { message: "unrouted", data: { path: "schema.properties.out.x-new-type" } },
    ]);
    expect((remapped!.data as any).path).toBe("schema.properties.out.x-new-type");
  });

  it("keys a record to its own file, so two modules sharing a name do not cross", async () => {
    // Resource names are module-scoped, so `Telo.Definition/Store` in two
    // libraries is ordinary. A record from one must never remap the other's
    // diagnostic.
    const definition = (body: string) =>
      ["kind: Telo.Definition", "metadata:", "  name: Store", body].join("\n") + "\n";
    const files = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "imports:",
        "  A: ./a",
        "  B: ./b",
        "",
      ].join("\n"),
      "/ws/a/telo.yaml":
        ["kind: Telo.Library", "metadata:", "  name: a", ""].join("\n") +
        "---\n" +
        definition(["schema:", "  properties:", "    out:", "      x-old-flag: true"].join("\n")),
      "/ws/b/telo.yaml":
        ["kind: Telo.Library", "metadata:", "  name: b", ""].join("\n") +
        "---\n" +
        definition(["schema:", "  properties:", "    other: {}"].join("\n")),
    };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });
    const graph = await loader.loadGraph("/ws/telo.yaml", {
      desugarImports: true,
      migrate: true,
    });

    // A diagnostic on library B's `Store`, at a path that only library A's
    // record covers. B's file declares no such rewrite, so nothing is remapped.
    const [remapped] = remapMigratedPaths(graph, [
      {
        message: "unrelated",
        data: {
          resource: { kind: "Telo.Definition", name: "Store" },
          filePath: "/ws/b/telo.yaml",
          path: "schema.properties.out.x-new-type",
        },
      },
    ]);
    expect((remapped!.data as any).path).toBe("schema.properties.out.x-new-type");
  });
});

describe("the core entry set", () => {
  const definition = (schema: string) =>
    [
      "kind: Telo.Definition",
      "metadata:",
      "  name: Thing",
      "capability: Telo.Invocable",
      "schema:",
      "  type: object",
      "  properties:",
      schema,
    ].join("\n") + "\n";

  it("loads every entry file, bound to its selector", () => {
    // The set is data — one file per entry under `analyzer/migrations/` — so
    // this asserts the files parse and bind, not that any particular entry is
    // present beyond the one below.
    expect(CORE_MIGRATIONS.length).toBeGreaterThan(0);
    for (const entry of CORE_MIGRATIONS) {
      expect(entry.id).toBeTruthy();
      expect(entry.code).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.rules.length).toBeGreaterThan(0);
    }
    expect(CORE_MIGRATIONS.map((e) => e.id)).toContain("ref-slot-scalar-type");
  });

  it("drops the stale scalar type a reference slot used to pin", () => {
    const text = definition(
      ["    handler:", "      type: string", "      x-telo-ref: Telo.Invocable"].join("\n"),
    );
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });

    expect((file.manifests[0] as any).schema.properties.handler).toEqual({
      "x-telo-ref": "Telo.Invocable",
    });
    const diagnostic = file.migrations.diagnostics[0]!;
    expect(diagnostic.code).toBe("X_TELO_REF_SCALAR_TYPE");
    expect((diagnostic.data as any).path).toBe("schema.properties.handler.type");
    expect(diagnostic.message).toContain("no quick fix (removes an entry)");
  });

  it("reaches a ref slot at any schema depth, in either annotation shape", () => {
    const text = definition(
      [
        "    steps:",
        "      type: array",
        "      items:",
        "        type: object",
        "        properties:",
        "          invoke:",
        "            type: string",
        "            x-telo-ref:",
        "              kind: Telo.Executable",
        "              use: call",
      ].join("\n"),
    );
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });
    expect(
      (file.manifests[0] as any).schema.properties.steps.items.properties.invoke.type,
    ).toBeUndefined();
    expect(file.migrations.rewrites[0]!.legacyPath).toBe(
      "schema.properties.steps.items.properties.invoke.type",
    );
  });

  it("leaves a slot whose type is not one of the legacy scalars", () => {
    // `object` was never the plain-string encoding, so it is a deliberate
    // constraint and not this entry's business.
    const text = definition(
      ["    handler:", "      type: object", "      x-telo-ref: Telo.Invocable"].join("\n"),
    );
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });
    expect(file.migrations.rewrites).toHaveLength(0);
  });

  it("never descends into a data-bearing keyword", () => {
    // A `default:` can hold a value that merely looks like a schema. Rewriting
    // inside one would edit the author's DATA, not their schema.
    const text = definition(
      [
        "    config:",
        "      type: object",
        "      default:",
        "        type: string",
        "        x-telo-ref: Telo.Invocable",
      ].join("\n"),
    );
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });
    expect(file.migrations.rewrites).toHaveLength(0);
    expect((file.manifests[0] as any).schema.properties.config.default).toEqual({
      type: "string",
      "x-telo-ref": "Telo.Invocable",
    });
  });

  it("is the ONLY thing that drops the stale type — so forgetting `migrate` fails loudly", () => {
    // The rewrite used to be duplicated in `normalizeRefSlots`, which ran at
    // every schema-compile site regardless of `LoadOptions.migrate`. That made
    // this entry structurally unable to prove the mechanism it exists to prove:
    // a consumer that forgot the flag behaved identically apart from the
    // missing warning. With the duplicate gone, an unmigrated slot keeps the
    // scalar `type` and the ordinary validator rejects the reference object
    // that reaches it.
    const text = definition(
      ["    handler:", "      type: string", "      x-telo-ref: Telo.Invocable"].join("\n"),
    );
    const raw = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text);
    expect((raw.manifests[0] as any).schema.properties.handler.type).toBe("string");

    const slot = (raw.manifests[0] as any).schema.properties.handler;
    const issues = validateAgainstSchema({ kind: "Telo.Invocable", name: "h" }, slot);
    expect(issues.length).toBeGreaterThan(0);

    // …and with the migration, the same value validates.
    const migrated = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });
    const migratedSlot = (migrated.manifests[0] as any).schema.properties.handler;
    expect(validateAgainstSchema({ kind: "Telo.Invocable", name: "h" }, migratedSlot)).toEqual([]);
  });

  it("is idempotent — the migrated spelling matches nothing", () => {
    const text = definition(["    handler:", "      x-telo-ref: Telo.Invocable"].join("\n"));
    const file = parseLoadedFile("/ws/telo.yaml", "/ws/telo.yaml", text, { migrate: true });
    expect(file.migrations.rewrites).toHaveLength(0);
  });
});

describe("entry files", () => {
  const entry = (rules: unknown[]) => ({
    id: "x",
    code: "X",
    severity: "warning",
    reason: "r",
    rules,
  });

  // The closed vocabulary is the trust boundary once module-shipped entries are
  // aggregated beside core ones: a rule that silently means more than it reads
  // is the one failure this cannot tolerate, so every unknown token is refused
  // rather than ignored.

  it("refuses an unknown operation rather than skipping it", () => {
    expect(() =>
      parseMigrationEntry(
        "bad.json",
        entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "move", to: "y" }] }]),
      ),
    ).toThrow(/is not one of/);
  });

  it("refuses an unknown parameter on a known operation", () => {
    expect(() =>
      parseMigrationEntry(
        "bad.json",
        entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "rename-key", too: "y" }] }]),
      ),
    ).toThrow(/has no parameter 'too'/);
  });

  it("refuses a set-value declaring both value and qualify", () => {
    expect(() =>
      parseMigrationEntry(
        "bad.json",
        entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "set-value", value: 1, qualify: "T." }] }]),
      ),
    ).toThrow(/exactly one of/);
  });

  it("refuses an unknown top-level entry key, but keeps $comment", () => {
    expect(() =>
      parseMigrationEntry("bad.json", {
        ...entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }]),
        sinceVersion: "0.5.0",
      }),
    ).toThrow(/an entry has no key 'sinceVersion'/);

    expect(() =>
      parseMigrationEntry("ok.json", {
        ...entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "remove-entry" }] }]),
        $comment: "why this rule is shaped the way it is",
      }),
    ).not.toThrow();
  });

  it("refuses a written value no YAML applier could express", () => {
    // "Every operation has a known YAML edit form" is what makes a migration
    // applicable to a FILE. A mapping has none — the file applier re-quotes a
    // value at the node's own span — so it is refused here rather than accepted
    // and then reported forever as "fix it by hand".
    for (const op of [
      { op: "set-value", value: { a: 1 } },
      { op: "insert-item", value: ["a"] },
    ]) {
      expect(() =>
        parseMigrationEntry("bad.json", entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [op] }])),
      ).toThrow(/must be a scalar/);
    }
    expect(() =>
      parseMigrationEntry(
        "ok.json",
        entry([{ match: { key: "k", ...TEST_SCOPE }, patch: [{ op: "set-value", value: null }] }]),
      ),
    ).not.toThrow();
  });

  it("refuses a match key the vocabulary does not define", () => {
    expect(() =>
      parseMigrationEntry(
        "bad.json",
        entry([{ match: { key: "k", ...TEST_SCOPE, underneath: ["x"] }, patch: [{ op: "remove-entry" }] }]),
      ),
    ).toThrow(/has no key 'underneath'/);
  });

  it("refuses a match declaring both value and valueOneOf", () => {
    expect(() =>
      parseMigrationEntry(
        "bad.json",
        entry([{ match: { key: "k", ...TEST_SCOPE, value: 1, valueOneOf: [1] }, patch: [{ op: "remove-entry" }] }]),
      ),
    ).toThrow(/at most one of/);
  });

  it("refuses a rule with no match block", () => {
    expect(() =>
      parseMigrationEntry("bad.json", entry([{ patch: [{ op: "remove-entry" }] }])),
    ).toThrow(/'match' must be a mapping/);
  });
});

describe("reporting scope", () => {
  it("rewrites an imported library but reports only the entry's own modules", async () => {
    const files = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "imports:",
        "  Lib: ./lib",
        "schema:",
        "  x-old-flag: true",
        "",
      ].join("\n"),
      "/ws/lib/telo.yaml": [
        "kind: Telo.Library",
        "metadata:",
        "  name: lib",
        "schema:",
        "  x-old-flag: true",
        "",
      ].join("\n"),
    };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });
    const graph = await loader.loadGraph("/ws/telo.yaml", {
      desugarImports: true,
      migrate: true,
    });

    // Both files were rewritten — a published artifact must keep loading.
    const lib = graph.modules.get("/ws/lib/telo.yaml")!;
    expect((lib.owner.manifests[0] as any).schema).toEqual({ "x-new-type": "Telo.Stream" });
    expect(lib.owner.migrations.rewrites).toHaveLength(1);

    // Only the entry's own module reports.
    expect(graph.migrationDiagnostics).toHaveLength(1);
    expect((graph.migrationDiagnostics[0]!.data as any).filePath).toBe("/ws/telo.yaml");
  });

  it("caches migrated and raw loads of one file separately", async () => {
    const files = { "/ws/telo.yaml": app(["schema:", "  x-old-flag: true"].join("\n")) };
    const loader = new Loader([inMemorySource(files)], { migrations: [renameEntry] });

    const migrated = await loader.loadFile("/ws/telo.yaml", { migrate: true });
    const raw = await loader.loadFile("/ws/telo.yaml");

    expect((migrated.manifests[0] as any).schema).toEqual({ "x-new-type": "Telo.Stream" });
    expect((raw.manifests[0] as any).schema).toEqual({ "x-old-flag": true });
  });
});
