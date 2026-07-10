import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import nock from "nock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  parseUpgradeRef,
  pickLatest,
  upgradeManifest,
  upgradeOne,
} from "../src/commands/upgrade.js";
import { createLogger } from "../src/logger.js";

const REGISTRY = "https://registry.example.test";
const log = createLogger(false);

// ---------------------------------------------------------------------------
// parseUpgradeRef — pure
// ---------------------------------------------------------------------------

describe("parseUpgradeRef", () => {
  it("parses a well-formed registry ref", () => {
    expect(parseUpgradeRef("std/run@1.2.3")).toEqual({
      namespace: "std",
      name: "run",
      version: "1.2.3",
      rawVersion: "1.2.3",
    });
  });

  it("normalizes a v-prefixed version via semver.valid", () => {
    const parsed = parseUpgradeRef("std/run@v1.2.3");
    expect(parsed?.version).toBe("1.2.3");
    expect(parsed?.rawVersion).toBe("v1.2.3");
  });

  it("returns version: null when the version segment is not valid semver", () => {
    const parsed = parseUpgradeRef("std/run@not-a-version");
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBeNull();
    // rawVersion is preserved so the diagnostic can quote what the user wrote.
    expect(parsed?.rawVersion).toBe("not-a-version");
  });

  it("rejects relative paths", () => {
    expect(parseUpgradeRef("../sibling")).toBeNull();
    expect(parseUpgradeRef("./sub")).toBeNull();
  });

  it("rejects HTTP(S) URLs", () => {
    expect(parseUpgradeRef("https://example.com/x@1.0.0")).toBeNull();
  });

  it("rejects refs with no namespace separator", () => {
    expect(parseUpgradeRef("standalone@1.0.0")).toBeNull();
  });

  it("rejects refs with a missing version segment", () => {
    expect(parseUpgradeRef("std/run@")).toBeNull();
    expect(parseUpgradeRef("std/run")).toBeNull();
  });

  it("rejects multi-slash names (registry refs have exactly one `/`)", () => {
    // Without this guard the registry GET would land on `/std/foo/bar` and
    // surface as "no published versions" instead of being skipped as
    // non-registry.
    expect(parseUpgradeRef("std/foo/bar@1.0.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickLatest — pure
// ---------------------------------------------------------------------------

describe("pickLatest", () => {
  it("returns the highest semver from an unordered list", () => {
    expect(pickLatest(["1.0.0", "2.0.0", "0.5.0"], false)).toBe("2.0.0");
  });

  it("excludes prereleases when includePrerelease=false", () => {
    expect(pickLatest(["1.0.0", "2.0.0-rc.1"], false)).toBe("1.0.0");
  });

  it("includes prereleases when includePrerelease=true", () => {
    expect(pickLatest(["1.0.0", "2.0.0-rc.1"], true)).toBe("2.0.0-rc.1");
  });

  it("returns null when every candidate is filtered out", () => {
    expect(pickLatest(["1.0.0-beta.1", "1.0.0-beta.2"], false)).toBeNull();
  });

  it("returns null on an empty input", () => {
    expect(pickLatest([], false)).toBeNull();
  });

  it("compares semver, not lexicographic — 10.0.0 beats 9.0.0", () => {
    expect(pickLatest(["9.0.0", "10.0.0", "2.0.0"], false)).toBe("10.0.0");
  });
});

// ---------------------------------------------------------------------------
// upgradeManifest — in-memory string in / string out, with mocked registry
// ---------------------------------------------------------------------------

function buildManifest(imports: Array<{ name: string; source: string }>): string {
  const lines: string[] = [
    "kind: Telo.Application",
    "metadata:",
    "  name: test-app",
    "  version: 0.0.1",
    "imports:",
  ];
  for (const imp of imports) {
    lines.push(`  ${imp.name}: ${imp.source}`);
  }
  return lines.join("\n") + "\n";
}

function mockVersions(namespace: string, name: string, versions: string[]) {
  return nock(REGISTRY)
    .get(`/${namespace}/${name}`)
    .reply(200, {
      name: `${namespace}/${name}`,
      version: versions[versions.length - 1] ?? "",
      versions,
    });
}

function mockManifest(namespace: string, name: string, version: string, body = "kind: Telo.Library\n") {
  return nock(REGISTRY).get(`/${namespace}/${name}/${version}/telo.yaml`).reply(200, body);
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

describe("upgradeManifest — registry interactions (in-memory)", () => {
  it("leaves an already-current, already-pinned import untouched (byte-for-byte, no manifest fetch)", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.7#sha256-EXISTING" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.unchanged).toBe(1);
    expect(result.pinned).toBe(0);
    expect(result.errors).toBe(0);
    expect(content).toBe(input);
  });

  it("pins an already-current unpinned import in place (no version change)", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.7" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    mockManifest("std", "run", "0.2.7");

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.pinned).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toMatch(/Run: std\/run@0\.2\.7#sha256-[A-Za-z0-9_-]+/);
  });

  it("leaves an already-current import unpinned when the manifest fetch fails (best-effort)", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.7" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    // telo.yaml endpoint intentionally not mocked → hash fetch fails.

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.pinned).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(content).toBe(input);
  });

  it("rewrites a real older pin to the latest published version", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.4" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: "std/run", from: "0.2.4", to: "0.2.7" },
    ]);
    expect(content).toContain("Run: std/run@0.2.7");
    expect(content).not.toContain("Run: std/run@0.2.4");
  });

  it("repairs a broken low pin (current not in published list) upward", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.0.1" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: "std/run", from: "0.0.1", to: "0.2.7" },
    ]);
    expect(content).toContain("Run: std/run@0.2.7");
  });

  it("repairs a broken high pin downward — only direction where downgrade is allowed", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@9.9.9" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: "std/run", from: "9.9.9", to: "0.2.7" },
    ]);
    expect(content).toContain("Run: std/run@0.2.7");
  });

  it("treats a registry 404 as skipped, not an error", async () => {
    const input = buildManifest([
      { name: "Missing", source: "std/does-not-exist@1.0.0" },
    ]);
    nock(REGISTRY).get("/std/does-not-exist").reply(404, { error: "Module not found" });

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toBe(input);
  });

  it("surfaces a non-404 registry failure as an error and leaves the manifest unchanged", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.4" }]);
    nock(REGISTRY).get("/std/run").reply(500, "boom");

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.errors).toBe(1);
    expect(content).toBe(input);
  });

  it("skips non-registry sources without making any HTTP call", async () => {
    const input = buildManifest([{ name: "Local", source: "../sibling" }]);
    // No nock interceptor — net is disabled, so any fetch attempt would throw.

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toBe(input);
  });

  it("respects --include-prerelease in both directions against the same versions list", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@1.0.0" }]);

    // Two GETs are made in this test — one per upgradeManifest call.
    nock(REGISTRY)
      .get("/std/run")
      .twice()
      .reply(200, {
        name: "std/run",
        version: "2.0.0-rc.1",
        versions: ["1.0.0", "2.0.0-rc.1"],
      });

    const stable = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });
    expect(stable.result.upgrades).toEqual([]);
    expect(stable.result.unchanged).toBe(1);
    expect(stable.content).toBe(input);

    const prereleased = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: true,
      log,
    });
    expect(prereleased.result.upgrades).toEqual([
      { packagePath: "std/run", from: "1.0.0", to: "2.0.0-rc.1" },
    ]);
    expect(prereleased.content).toContain("Run: std/run@2.0.0-rc.1");
  });

  it("rewrites multiple inline imports in one map", async () => {
    const input = buildManifest([
      { name: "Run", source: "std/run@0.2.4" },
      { name: "Type", source: "std/type@1.0.0" },
    ]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    mockVersions("std", "type", ["1.0.0", "1.0.5"]);

    const { content } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(content).toContain("Run: std/run@0.2.7");
    expect(content).toContain("Type: std/type@1.0.5");
  });

  it("rewrites the object form (`Alias: { source: … }`) source", async () => {
    const input = [
      "kind: Telo.Application",
      "metadata:",
      "  name: test-app",
      "  version: 0.0.1",
      "imports:",
      "  Run:",
      "    source: std/run@0.2.4",
      "    variables:",
      "      flag: true",
      "",
    ].join("\n");
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: "std/run", from: "0.2.4", to: "0.2.7" },
    ]);
    expect(content).toContain("source: std/run@0.2.7");
    // The sibling `variables:` block under the same entry is untouched.
    expect(content).toContain("      flag: true");
  });

  it("preserves a folded block scalar (`>-`) in an unrelated doc byte-for-byte", async () => {
    // A folded block scalar's source line breaks are presentation-only — once
    // parsed, the value is a single string with spaces. Going through
    // `Document.toString()` would re-emit it on one line. The splice
    // implementation never calls toString on this doc, so the original line
    // structure must survive.
    const sqlBlock = [
      "kind: Sql.Query",
      "metadata:",
      "  name: InsertToken",
      "inputs:",
      "  sql: >-",
      "    INSERT INTO tokens (user_id, token_hash, label)",
      "    SELECT id, $1, 'root-publish-token' FROM users WHERE username = 'root'",
      "    ON CONFLICT (user_id, label) DO UPDATE SET token_hash = EXCLUDED.token_hash",
      "  bindings:",
      "    - \"abc\"",
    ].join("\n");
    const input =
      buildManifest([{ name: "Run", source: "std/run@0.2.4" }]) + "---\n" + sqlBlock + "\n";

    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toHaveLength(1);
    expect(content).toContain("Run: std/run@0.2.7");
    // The folded-block source lines must survive verbatim — no collapse onto a
    // single line.
    expect(content).toContain(sqlBlock);
  });

  it("preserves the quote style of the source scalar on rewrite", async () => {
    // Plain scalar — written back as plain.
    const plainInput = buildManifest([{ name: "Run", source: "std/run@0.2.4" }]);
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    const plain = await upgradeManifest({
      content: plainInput,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });
    expect(plain.content).toContain("Run: std/run@0.2.7");
    expect(plain.content).not.toContain('Run: "std/run@0.2.7"');

    // Double-quoted scalar — quotes kept.
    const dqInput = plainInput.replace(
      "Run: std/run@0.2.4",
      'Run: "std/run@0.2.4"',
    );
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    const dq = await upgradeManifest({
      content: dqInput,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });
    expect(dq.content).toContain('Run: "std/run@0.2.7"');
    expect(dq.content).not.toContain("Run: std/run@0.2.7\n");

    // Single-quoted scalar — quotes kept.
    const sqInput = plainInput.replace(
      "Run: std/run@0.2.4",
      "Run: 'std/run@0.2.4'",
    );
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);
    const sq = await upgradeManifest({
      content: sqInput,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });
    expect(sq.content).toContain("Run: 'std/run@0.2.7'");
  });

  it("everything outside the rewritten source value is byte-identical to the input", async () => {
    // Construct a manifest with multiple imports plus a noisy unrelated doc
    // (comments, indentation oddities, trailing whitespace) and verify the
    // diff is exactly the bumped pin chars.
    const before = [
      "# Top-of-file comment.",
      "kind: Telo.Application",
      "metadata:",
      "  name: probe",
      "  version: 0.0.1",
      "imports:",
      "  Run: std/run@0.2.4   # trailing comment",
      "---",
      "# Comment between docs.",
      "kind: Other.Resource",
      "metadata:",
      "  name: Noisy",
      "values:",
      "  - one",
      "  -    two", // odd spacing
      "  - 'three'",
      "",
    ].join("\n");

    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content } = await upgradeManifest({
      content: before,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    // The only delta is the version chars — comments, spacing, the noisy doc
    // are byte-identical.
    expect(content).toBe(before.replace("std/run@0.2.4", "std/run@0.2.7"));
  });

  it("does not reflow long double-quoted scalars when rewriting a different doc", async () => {
    // A CEL-template-style scalar well over the yaml library's default
    // 80-col line width. Without `lineWidth: 0` on toString(), the library
    // would fold this with `\` continuations on rewrite.
    const longCel =
      "${{ type(steps.parseManifest.result.docs[?0].?metadata.?description.orValue('')) == string ? steps.parseManifest.result.docs[?0].?metadata.?description.orValue(null) : null }}";
    const input =
      buildManifest([{ name: "Run", source: "std/run@0.2.4" }]) +
      "---\n" +
      "kind: Some.Resource\n" +
      "metadata:\n" +
      "  name: Probe\n" +
      `expr: "${longCel}"\n`;

    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toHaveLength(1);
    // Source was rewritten as expected …
    expect(content).toContain("Run: std/run@0.2.7");
    // … but the long scalar in the unrelated doc must survive verbatim — no
    // line wrap, no backslash continuations.
    expect(content).toContain(`expr: "${longCel}"`);
    expect(content).not.toContain("\\\n");
  });

  it("returns a per-import diagnostic for an unparseable current version", async () => {
    const input = buildManifest([{ name: "Run", source: "std/run@not-a-version" }]);
    mockVersions("std", "run", ["1.0.0"]);

    const { content, result } = await upgradeManifest({
      content: input,
      registryUrl: REGISTRY,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(content).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// upgradeOne — disk-backed wrapper. Only the wrapper-specific behavior is
// covered here; the parse / fetch / decision pipeline is exercised by the
// upgradeManifest suite above.
// ---------------------------------------------------------------------------

describe("upgradeOne — filesystem wrapper", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-upgrade-test-"));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("resolves a directory path to <dir>/telo.yaml and writes the rewrite back", async () => {
    const manifestPath = path.join(workdir, "telo.yaml");
    fs.writeFileSync(
      manifestPath,
      buildManifest([{ name: "Run", source: "std/run@0.2.4" }]),
      "utf-8",
    );
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const result = await upgradeOne(workdir, REGISTRY, false, false, log);

    expect(result.upgrades).toHaveLength(1);
    expect(fs.readFileSync(manifestPath, "utf-8")).toContain("Run: std/run@0.2.7");
  });

  it("dry-run hits the registry but never writes the file", async () => {
    const manifestPath = path.join(workdir, "telo.yaml");
    const input = buildManifest([{ name: "Run", source: "std/run@0.2.4" }]);
    fs.writeFileSync(manifestPath, input, "utf-8");
    mockVersions("std", "run", ["0.2.4", "0.2.7"]);

    const result = await upgradeOne(manifestPath, REGISTRY, false, true, log);

    expect(result.upgrades).toEqual([
      { packagePath: "std/run", from: "0.2.4", to: "0.2.7" },
    ]);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(input);
  });
});
