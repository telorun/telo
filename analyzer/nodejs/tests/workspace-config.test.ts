import { describe, expect, it } from "vitest";
import { lastMatchIndex } from "@telorun/glob";
import {
  checkDestinationCollisions,
  checkImportDestinations,
} from "../src/release/destinations.js";
import {
  DEFAULT_ENV_FILES,
  DEFAULT_RELEASE_IGNORE,
  diagnosticsFor,
  matchesPatterns,
  readWorkspaceConfig,
  requireReleaseSettings,
  settingsForModule,
} from "../src/release/workspace-config.js";

const read = (text: string) => readWorkspaceConfig(text, "telo-workspace.yaml");
const codes = (text: string) => read(text).diagnostics.map((d) => d.code);

describe("the marker's shape", () => {
  it("accepts a file whose whole content is comments — what a runner seeds", () => {
    const { config, diagnostics } = read("# just an anchor\n");
    expect(diagnostics).toEqual([]);
    expect(config).toEqual({});
  });

  it("names the move when 'modules:' is still at the top level", () => {
    // Not a generic unknown-field rejection: the key is recognized, and what an
    // author needs is where it went.
    const { diagnostics } = read("modules:\n  - modules/*\n");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("WORKSPACE_MODULES_MOVED");
    expect(diagnostics[0].path).toEqual(["modules"]);
    expect(diagnostics[0].message).toContain("under 'release:'");
  });

  it("reports every problem, not just the first — an editor wants all of them", () => {
    const { diagnostics } = read(
      "release:\n  registry: 7\n  nope: 1\nenv:\n  filez: []\n",
    );
    expect(diagnostics.map((d) => d.path.join("."))).toEqual([
      "release.nope",
      "release.registry",
      "env.filez",
    ]);
  });

  it("errors on a near-miss block and warns on one it is merely too old to know", () => {
    // A typo's settings would otherwise go silently unapplied; an unrecognized
    // block is a version skew, so the next one ships without breaking runs.
    expect(codes("relase:\n  modules: [x]\n")).toEqual(["WORKSPACE_UNKNOWN_KEY"]);
    expect(read("relase:\n  modules: [x]\n").diagnostics[0].severity).toBe("error");
    expect(read("telemetry:\n  sink: x\n").diagnostics[0].severity).toBe("warning");
  });

  it("refuses a path or a glob in env.files, since the walk's reach is env.roots", () => {
    const { diagnostics } = read("env:\n  files: ['.env', 'cfg/.env']\n");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toEqual(["env", "files", 1]);
  });

  it("normalizes a bare string entry and reads an object one", () => {
    const { config } = read(
      "release:\n  modules:\n    - modules/*\n    - path: vendor/aws/*\n      registry: oci://ghcr.io/telorun/aws\n",
    );
    expect(config.release?.modules).toEqual([
      { path: "modules/*" },
      { path: "vendor/aws/*", registry: "oci://ghcr.io/telorun/aws" },
    ]);
  });
});

describe("what a caller does with the diagnostics", () => {
  it("scopes them per block, so a release typo does not reach the run path", () => {
    const { diagnostics } = read("release:\n  nope: 1\nenv:\n  files: ['a/b']\n");
    expect(diagnosticsFor(diagnostics, "env").map((d) => d.path.join("."))).toEqual([
      "env.files.0",
    ]);
  });

  it("throws for `telo release` when the block is absent", () => {
    expect(() => requireReleaseSettings(read("# anchor\n"), "telo-workspace.yaml")).toThrow(
      /declares no 'release\.modules'/,
    );
  });
});

describe("the cascade", () => {
  const config = read(
    [
      "release:",
      "  registry: oci://ghcr.io/telorun",
      "  ignore: ['**/tests/**']",
      "  modules:",
      "    - modules/*",
      "    - '!modules/scratch'",
      "    - path: vendor/aws/*",
      "      registry: oci://ghcr.io/telorun/aws",
      "    - path: modules/sql",
      "      ignore: []",
    ].join("\n"),
  ).config.release!;

  const settings = (key: string) => settingsForModule(config, key, lastMatchIndex);

  it("merges key-wise: an entry naming only registry keeps the block's ignore", () => {
    expect(settings("vendor/aws/s3")).toEqual({
      entry: 2,
      registry: "oci://ghcr.io/telorun/aws",
      ignore: ["**/tests/**"],
    });
  });

  it("gives a later, more specific entry the last word", () => {
    expect(settings("modules/sql")?.ignore).toEqual([]);
    expect(settings("modules/ai")?.ignore).toEqual(["**/tests/**"]);
  });

  it("treats a negation entry as an exclusion, which supplies nothing", () => {
    expect(settings("modules/scratch")).toBeUndefined();
  });

  it("falls back to the built-in ignore where nothing declares one", () => {
    const bare = read("release:\n  modules: [modules/*]\n").config.release!;
    expect(settingsForModule(bare, "modules/ai", lastMatchIndex)?.ignore).toBe(
      DEFAULT_RELEASE_IGNORE,
    );
  });

  it("ignores a nested test suite, which the module-root anchoring missed", () => {
    const ignore = DEFAULT_RELEASE_IGNORE;
    expect(matchesPatterns("nodejs/tests/sql.test.ts", ignore, lastMatchIndex)).toBe(true);
    expect(matchesPatterns("chat/tests/authors.yaml", ignore, lastMatchIndex)).toBe(true);
    expect(matchesPatterns("nodejs/src/index.ts", ignore, lastMatchIndex)).toBe(false);
  });
});

describe("destinations", () => {
  it("refuses two modules resolving to one ref", () => {
    const diagnostics = checkDestinationCollisions([
      { key: "vendor/aws/storage", destination: "oci://ghcr.io/acme/storage" },
      { key: "vendor/google/storage", destination: "oci://ghcr.io/acme/storage" },
      { key: "modules/sql", destination: "oci://ghcr.io/acme/sql" },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("DESTINATION_COLLISION");
    expect(diagnostics[0].message).toContain("vendor/aws/storage and vendor/google/storage");
  });

  it("refuses a relative import whose derived ref is not where the target publishes", () => {
    const diagnostics = checkImportDestinations([
      {
        from: "vendor/acme/billing",
        to: "modules/sql",
        derived: "oci://registry.acme.internal/sql",
        assigned: "oci://ghcr.io/telorun/sql",
      },
      {
        from: "modules/ai",
        to: "modules/sql",
        derived: "oci://ghcr.io/telorun/sql",
        assigned: "oci://ghcr.io/telorun/sql",
      },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("IMPORT_DESTINATION_CONFLICT");
  });
});

describe("env defaults", () => {
  it("keeps the pair the walk hardcoded, in the order it applied them", () => {
    expect(DEFAULT_ENV_FILES).toEqual([".env", ".env.local"]);
  });
});
