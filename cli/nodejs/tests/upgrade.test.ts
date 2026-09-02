import { makeTarGz } from "@telorun/kernel";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import nock from "nock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pickLatest, upgradeManifest, upgradeOne } from "../src/commands/upgrade.js";
import { createLogger } from "../src/logger.js";

const HOST = "oci.example.test";
const ORIGIN = `https://${HOST}`;
const log = createLogger(false);

/** `oci://host/repo@version` — the one ref grammar that carries a version. */
const ref = (repo: string, version: string): string => `oci://${HOST}/${repo}@${version}`;
/** The version-independent label `upgrade` reports an import under. */
const label = (repo: string): string => `oci://${HOST}/${repo}`;

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
// upgradeManifest — in-memory string in / string out, over a mocked OCI
// distribution registry. Version enumeration is `/v2/<repo>/tags/list`; pinning
// pulls the artifact manifest and then the blob holding its `telo.yaml` layer.
// ---------------------------------------------------------------------------

const LIB = "kind: Telo.Library\n";
let libTar: Buffer;
let libDigest: string;

beforeAll(async () => {
  libTar = await makeTarGz([{ name: "telo.yaml", content: LIB }]);
  libDigest = `sha256:${createHash("sha256").update(libTar).digest("hex")}`;
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

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

/** The tag list for `repo`. `times` covers a case that calls `upgradeManifest`
 *  more than once against a single interceptor. */
function mockVersions(repo: string, versions: string[], times = 1) {
  return nock(ORIGIN)
    .get(`/v2/${repo}/tags/list`)
    .query(true)
    .times(times)
    .reply(200, { name: repo, tags: versions });
}

/** The two-hop pull `manifestHash` performs. Without both, pinning fails and
 *  the import is reported as left unpinned. */
function mockManifest(repo: string, version: string) {
  nock(ORIGIN)
    .get(`/v2/${repo}/manifests/${version}`)
    .reply(200, {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: libDigest, size: 0 },
      layers: [
        {
          mediaType: "application/vnd.telo.module.manifest.v1+tar",
          digest: libDigest,
          size: libTar.length,
        },
      ],
    });
  nock(ORIGIN).get(`/v2/${repo}/blobs/${libDigest}`).reply(200, libTar);
}

describe("upgradeManifest — origin interactions (in-memory)", () => {
  it("leaves an already-current, already-pinned import untouched (byte-for-byte, no manifest fetch)", async () => {
    const input = buildManifest([
      { name: "Run", source: `${ref("telorun/run", "0.2.7")}#sha256-EXISTING` },
    ]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
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
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.7") }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    mockManifest("telorun/run", "0.2.7");

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.pinned).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toContain(`${ref("telorun/run", "0.2.7")}#sha256-`);
  });

  it("leaves an already-current import unpinned when the manifest fetch fails (best-effort)", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.7") }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    // The manifest pull fails, so the pin cannot be computed.
    nock(ORIGIN).get("/v2/telorun/run/manifests/0.2.7").reply(404);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.pinned).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(content).toBe(input);
  });

  it("rewrites a real older pin to the latest published version", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.2.4", to: "0.2.7" },
    ]);
    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
    expect(content).not.toContain(`Run: ${ref("telorun/run", "0.2.4")}`);
  });

  it("repairs a broken low pin (current not in published list) upward", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.0.1") }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.0.1", to: "0.2.7" },
    ]);
    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
  });

  it("repairs a broken high pin downward — only direction where downgrade is allowed", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "9.9.9") }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "9.9.9", to: "0.2.7" },
    ]);
    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
  });

  it("treats an unknown repository as skipped, not an error", async () => {
    const input = buildManifest([
      { name: "Missing", source: ref("telorun/does-not-exist", "1.0.0") },
    ]);
    nock(ORIGIN).get("/v2/telorun/does-not-exist/tags/list").query(true).reply(404, {});

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toBe(input);
  });

  it("surfaces a non-404 origin failure as an error and leaves the manifest unchanged", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]);
    nock(ORIGIN).get("/v2/telorun/run/tags/list").query(true).reply(500, "boom");

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.errors).toBe(1);
    expect(content).toBe(input);
  });

  it("skips a local sibling import without making any HTTP call", async () => {
    const input = buildManifest([{ name: "Local", source: "../sibling" }]);
    // No nock interceptor — net is disabled, so any fetch attempt would throw.

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
    expect(content).toBe(input);
  });

  it("skips a ref pinned to a digest — there is no version ordering to follow", async () => {
    const input = buildManifest([
      { name: "Run", source: `oci://${HOST}/telorun/run@sha256:deadbeef` },
    ]);
    mockVersions("telorun/run", ["0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(content).toBe(input);
  });

  it("respects --include-prerelease in both directions against the same versions list", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "1.0.0") }]);

    // Two tag-list reads are made — one per upgradeManifest call.
    mockVersions("telorun/run", ["1.0.0", "2.0.0-rc.1"], 2);
    // The stable pass finds nothing newer, so it pins the version already named.
    mockManifest("telorun/run", "1.0.0");

    const stable = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });
    expect(stable.result.upgrades).toEqual([]);
    expect(stable.result.pinned).toBe(1);

    const prereleased = await upgradeManifest({
      content: input,
      includePrerelease: true,
      log,
    });
    expect(prereleased.result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "1.0.0", to: "2.0.0-rc.1" },
    ]);
    expect(prereleased.content).toContain(`Run: ${ref("telorun/run", "2.0.0-rc.1")}`);
  });

  it("rewrites multiple inline imports in one map", async () => {
    const input = buildManifest([
      { name: "Run", source: ref("telorun/run", "0.2.4") },
      { name: "Type", source: ref("telorun/type", "1.0.0") },
    ]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    mockVersions("telorun/type", ["1.0.0", "1.0.5"]);

    const { content } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
    expect(content).toContain(`Type: ${ref("telorun/type", "1.0.5")}`);
  });

  it("rewrites the object form (`Alias: { source: … }`) source", async () => {
    const input = [
      "kind: Telo.Application",
      "metadata:",
      "  name: test-app",
      "  version: 0.0.1",
      "imports:",
      "  Run:",
      `    source: ${ref("telorun/run", "0.2.4")}`,
      "    variables:",
      "      flag: true",
      "",
    ].join("\n");
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.2.4", to: "0.2.7" },
    ]);
    expect(content).toContain(`source: ${ref("telorun/run", "0.2.7")}`);
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
      '    - "abc"',
    ].join("\n");
    const input =
      buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]) +
      "---\n" +
      sqlBlock +
      "\n";

    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toHaveLength(1);
    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
    // The folded-block source lines must survive verbatim — no collapse onto a
    // single line.
    expect(content).toContain(sqlBlock);
  });

  it("preserves the quote style of the source scalar on rewrite", async () => {
    const old = ref("telorun/run", "0.2.4");
    const next = ref("telorun/run", "0.2.7");

    // Plain scalar — written back as plain.
    const plainInput = buildManifest([{ name: "Run", source: old }]);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    const plain = await upgradeManifest({
      content: plainInput,
      includePrerelease: false,
      log,
    });
    expect(plain.content).toContain(`Run: ${next}`);
    expect(plain.content).not.toContain(`Run: "${next}"`);

    // Double-quoted scalar — quotes kept.
    const dqInput = plainInput.replace(`Run: ${old}`, `Run: "${old}"`);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    const dq = await upgradeManifest({
      content: dqInput,
      includePrerelease: false,
      log,
    });
    expect(dq.content).toContain(`Run: "${next}"`);
    expect(dq.content).not.toContain(`Run: ${next}\n`);

    // Single-quoted scalar — quotes kept.
    const sqInput = plainInput.replace(`Run: ${old}`, `Run: '${old}'`);
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    const sq = await upgradeManifest({
      content: sqInput,
      includePrerelease: false,
      log,
    });
    expect(sq.content).toContain(`Run: '${next}'`);
  });

  it("everything outside the rewritten source value is byte-identical to the input", async () => {
    // Construct a manifest with an import plus a noisy unrelated doc (comments,
    // indentation oddities, trailing comment) and verify the diff is exactly
    // the bumped pin chars.
    const before = [
      "# Top-of-file comment.",
      "kind: Telo.Application",
      "metadata:",
      "  name: probe",
      "  version: 0.0.1",
      "imports:",
      `  Run: ${ref("telorun/run", "0.2.4")}   # trailing comment`,
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

    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content } = await upgradeManifest({
      content: before,
      includePrerelease: false,
      log,
    });

    // The only delta is the version chars — comments, spacing, the noisy doc
    // are byte-identical.
    expect(content).toBe(before.replace("run@0.2.4", "run@0.2.7"));
  });

  it("does not reflow long double-quoted scalars when rewriting a different doc", async () => {
    // A CEL-template-style scalar well over the yaml library's default
    // 80-col line width. Without `lineWidth: 0` on toString(), the library
    // would fold this with `\` continuations on rewrite.
    const longCel =
      "${{ type(steps.parseManifest.result.docs[?0].?metadata.?description.orValue('')) == string ? steps.parseManifest.result.docs[?0].?metadata.?description.orValue(null) : null }}";
    const input =
      buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]) +
      "---\n" +
      "kind: Some.Resource\n" +
      "metadata:\n" +
      "  name: Probe\n" +
      `expr: "${longCel}"\n`;

    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const { content, result } = await upgradeManifest({
      content: input,
      includePrerelease: false,
      log,
    });

    expect(result.upgrades).toHaveLength(1);
    // Source was rewritten as expected …
    expect(content).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
    // … but the long scalar in the unrelated doc must survive verbatim — no
    // line wrap, no backslash continuations.
    expect(content).toContain(`expr: "${longCel}"`);
    expect(content).not.toContain("\\\n");
  });

  it("returns a per-import diagnostic for an unparseable current version", async () => {
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "not-a-version") }]);
    mockVersions("telorun/run", ["1.0.0"]);

    const { content, result } = await upgradeManifest({
      content: input,
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
      buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]),
      "utf-8",
    );
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const result = await upgradeOne(workdir, false, false, log);

    expect(result.upgrades).toHaveLength(1);
    expect(fs.readFileSync(manifestPath, "utf-8")).toContain(
      `Run: ${ref("telorun/run", "0.2.7")}`,
    );
  });

  it("dry-run hits the origin but never writes the file", async () => {
    const manifestPath = path.join(workdir, "telo.yaml");
    const input = buildManifest([{ name: "Run", source: ref("telorun/run", "0.2.4") }]);
    fs.writeFileSync(manifestPath, input, "utf-8");
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);

    const result = await upgradeOne(manifestPath, false, true, log);

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.2.4", to: "0.2.7" },
    ]);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(input);
  });

  it("without --recursive, a relative import is skipped and never followed", async () => {
    const rootPath = path.join(workdir, "telo.yaml");
    const libPath = path.join(workdir, "lib", "telo.yaml");
    fs.mkdirSync(path.join(workdir, "lib"));
    fs.writeFileSync(
      rootPath,
      buildManifest([
        { name: "Run", source: ref("telorun/run", "0.2.4") },
        { name: "Lib", source: "./lib" },
      ]),
      "utf-8",
    );
    const libInput = buildManifest([{ name: "Type", source: ref("telorun/type", "1.0.0") }]);
    fs.writeFileSync(libPath, libInput, "utf-8");
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    // telorun/type is NOT mocked — if the lib were followed, its fetch would throw.

    const result = await upgradeOne(rootPath, false, false, log);

    expect(result.upgrades).toHaveLength(1); // only telorun/run
    expect(result.skipped).toBe(1); // the relative ./lib import
    expect(fs.readFileSync(libPath, "utf-8")).toBe(libInput); // untouched
  });

  it("with --recursive, follows a relative import and upgrades the sibling too", async () => {
    const rootPath = path.join(workdir, "telo.yaml");
    const libDir = path.join(workdir, "lib");
    const libPath = path.join(libDir, "telo.yaml");
    fs.mkdirSync(libDir);
    fs.writeFileSync(
      rootPath,
      buildManifest([
        { name: "Run", source: ref("telorun/run", "0.2.4") },
        { name: "Lib", source: "./lib" },
      ]),
      "utf-8",
    );
    fs.writeFileSync(
      libPath,
      buildManifest([{ name: "Type", source: ref("telorun/type", "1.0.0") }]),
      "utf-8",
    );
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    mockVersions("telorun/type", ["1.0.0", "1.0.5"]);

    const result = await upgradeOne(rootPath, false, false, log, true);

    // Aggregated over both files, and the relative import is not counted skipped.
    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.2.4", to: "0.2.7" },
      { packagePath: label("telorun/type"), from: "1.0.0", to: "1.0.5" },
    ]);
    expect(result.skipped).toBe(0);
    expect(fs.readFileSync(rootPath, "utf-8")).toContain(`Run: ${ref("telorun/run", "0.2.7")}`);
    expect(fs.readFileSync(libPath, "utf-8")).toContain(`Type: ${ref("telorun/type", "1.0.5")}`);
  });

  it("with --recursive, an import cycle upgrades each file exactly once", async () => {
    const aPath = path.join(workdir, "telo.yaml");
    const bDir = path.join(workdir, "b");
    const bPath = path.join(bDir, "telo.yaml");
    fs.mkdirSync(bDir);
    // a → ./b → ../  (back to a): a cycle.
    fs.writeFileSync(
      aPath,
      buildManifest([
        { name: "Run", source: ref("telorun/run", "0.2.4") },
        { name: "B", source: "./b" },
      ]),
      "utf-8",
    );
    fs.writeFileSync(
      bPath,
      buildManifest([
        { name: "Type", source: ref("telorun/type", "1.0.0") },
        { name: "A", source: "../" },
      ]),
      "utf-8",
    );
    // One interceptor each — a second visit would need a second read and fail.
    mockVersions("telorun/run", ["0.2.4", "0.2.7"]);
    mockVersions("telorun/type", ["1.0.0", "1.0.5"]);

    const result = await upgradeOne(aPath, false, false, log, true);

    expect(result.upgrades).toEqual([
      { packagePath: label("telorun/run"), from: "0.2.4", to: "0.2.7" },
      { packagePath: label("telorun/type"), from: "1.0.0", to: "1.0.5" },
    ]);
    expect(result.errors).toBe(0);
  });
});
