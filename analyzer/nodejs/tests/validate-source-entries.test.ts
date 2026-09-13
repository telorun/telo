import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { validateSourceEntries } from "../src/validate-source-entries.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const SHA = "a".repeat(64);

const native = [
  {
    name: "addon",
    format: "napi",
    os: "linux",
    arch: "amd64",
    path: "./native/linux-amd64/addon.node",
  },
];

const pinned = (member: string) => ({ upstream: "linux-x64", member, sha256: SHA, executable: false });

const validSource = () => ({
  version: "1.2.0",
  url: "https://example.test/addon-{version}-{upstream}.tgz",
  archive: "tar.gz",
  notices: ["./notices/addon.LICENSE"],
  build: { cargo: "./rust", inputs: `sha256-${"A".repeat(43)}` },
  entries: {
    "./native/linux-amd64/addon.node": pinned("package/addon.node"),
    "./native/linux-amd64/addon.so": { target: "addon.node" },
    "./rust/linux-amd64/ctl.node": pinned("package/ctl.node"),
    "./notices/addon.LICENSE": pinned("package/LICENSE"),
  },
});

const manifests = (kind: "Telo.Library" | "Telo.Application", sources: unknown) =>
  withSyntheticPositions([
    {
      kind,
      metadata: { name: "Demo", source: "file:///demo/telo.yaml" },
      native: [...native, { ...native[0], name: "alias", path: "./native/linux-amd64/addon.so" }],
      sources,
    },
    {
      kind: "Telo.Definition",
      metadata: { name: "Thing", module: "Demo", source: "file:///demo/telo.yaml" },
      capability: "Telo.Invocable",
      controllers: [
        "pkg:telo/local/napi?path=./rust/linux-amd64/ctl.node&os=linux&arch=amd64",
        "pkg:telo/local/js?path=./nodejs/demo.mjs",
      ],
      schema: { type: "object" },
    },
  ] as unknown as ResourceManifest[]);

const analyze = (kind: "Telo.Library" | "Telo.Application", sources: unknown) =>
  new StaticAnalyzer()
    .analyze(manifests(kind, sources))
    .filter((d) => d.code.startsWith("SOURCE_") || d.code === "SCHEMA_VIOLATION");

const check = (sources: unknown) =>
  validateSourceEntries(manifests("Telo.Library", sources), new Set(["Demo"])).map((d) => [
    d.code,
    d.data?.path,
  ]);

const withEntries = (entries: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  addon: { ...validSource(), ...overrides, entries: { ...validSource().entries, ...entries } },
});

describe("sources: block", () => {
  it.each(["Telo.Library", "Telo.Application"] as const)(
    "is accepted on %s and reports nothing when valid",
    (kind) => {
      expect(analyze(kind, { addon: validSource() })).toEqual([]);
    },
  );

  it.each([
    ["an unknown key", { addon: { ...validSource(), homepage: "x" } }],
    ["a missing required field", { addon: { ...validSource(), version: undefined } }],
    ["a missing archive", { addon: { ...validSource(), archive: undefined } }],
    ["an unknown archive format", { addon: { ...validSource(), archive: "zip" } }],
    ["the removed crate key", { addon: { ...validSource(), build: undefined, crate: "./rust" } }],
    ["a build keyed by no build system", { addon: { ...validSource(), build: { inputs: "x" } } }],
    ["empty notices", { addon: { ...validSource(), notices: [] } }],
    ["an entry with neither shape", withEntries({ "./native/linux-amd64/addon.node": { sha256: SHA } })],
  ])("reports %s as a schema violation", (_label, sources) => {
    const codes = analyze("Telo.Library", JSON.parse(JSON.stringify(sources))).map((d) => d.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(["SCHEMA_VIOLATION"]));
  });

  it.each([
    [
      "SOURCE_URL_PLACEHOLDER_UNKNOWN",
      withEntries({}, { url: "https://example.test/{os}/{version}.tgz" }),
      "sources.addon.url",
    ],
    [
      "SOURCE_URL_INSECURE",
      withEntries({}, { url: "http://example.test/{version}.tgz" }),
      "sources.addon.url",
    ],
    ["SOURCE_INVALID", withEntries({}, { url: "example.test/{version}.tgz" }), "sources.addon.url"],
    [
      "SOURCE_ENTRY_UNCLAIMED",
      withEntries({ "./native/darwin/addon.node": pinned("addon.node") }),
      "sources.addon.entries../native/darwin/addon.node",
    ],
    [
      "SOURCE_ENTRY_UNPINNED",
      withEntries({ "./rust/linux-amd64/ctl.node": { upstream: "linux-x64", member: "ctl.node" } }),
      "sources.addon.entries../rust/linux-amd64/ctl.node",
    ],
    ["SOURCE_BUILD_UNPINNED", withEntries({}, { build: { cargo: "./rust" } }), "sources.addon.build"],
    [
      "SOURCE_LINK_CYCLE",
      withEntries({ "./native/linux-amd64/addon.so": { target: "addon.so" } }),
      "sources.addon.entries../native/linux-amd64/addon.so.target",
    ],
    [
      "SOURCE_ENTRY_NESTED",
      withEntries({ "./native/linux-amd64/addon.node/inner": pinned("inner") }),
      "sources.addon.entries../native/linux-amd64/addon.node/inner",
    ],
    [
      "SOURCE_LINK_TARGET_UNRESOLVED",
      withEntries({ "./native/linux-amd64/addon.so": { target: "missing.node" } }),
      "sources.addon.entries../native/linux-amd64/addon.so.target",
    ],
    [
      "SOURCE_ENTRY_INVALID",
      withEntries({ "./native/linux-amd64/addon.so": { target: "addon.node", sha256: SHA } }),
      "sources.addon.entries../native/linux-amd64/addon.so",
    ],
    [
      "SOURCE_ENTRY_INVALID",
      withEntries({
        "./native/linux-amd64/addon.node": {
          upstream: "linux-x64",
          member: "package/addon.node",
          sha256: "ABC",
          executable: false,
        },
      }),
      "sources.addon.entries../native/linux-amd64/addon.node.sha256",
    ],
    ["SOURCE_INVALID", { Addon: validSource() }, "sources.Addon"],
    [
      "SOURCE_INVALID",
      withEntries({}, { build: { cargo: "../../sdk/rust", inputs: `sha256-${"A".repeat(43)}` } }),
      "sources.addon.build.cargo",
    ],
    [
      "SOURCE_INVALID",
      withEntries({}, { build: { cargo: "./rust", inputs: `sha256:${SHA}` } }),
      "sources.addon.build.inputs",
    ],
    [
      "SOURCE_ENTRY_INVALID",
      withEntries({
        "./native/linux-amd64/addon.node": {
          upstream: "linux-x64",
          member: "package/addon.node",
          sha256: SHA,
        },
      }),
      "sources.addon.entries../native/linux-amd64/addon.node",
    ],
  ])("reports %s at the offending key", (code, sources, path) => {
    expect(check(sources)).toEqual([[code, path]]);
  });

  it("is reported by analyze() at a ./-prefixed entry's own key", () => {
    const sources = withEntries({ "./native/x.node": pinned("x.node") });
    expect(analyze("Telo.Library", sources).map((d) => [d.code, d.data?.path])).toEqual([
      ["SOURCE_ENTRY_UNCLAIMED", "sources.addon.entries../native/x.node"],
    ]);
  });

  it("is reported by analyze() at a link whose target ships in another layer", () => {
    // The `alias` entry names the link for linux; its target is the darwin file.
    const owner = manifests(
      "Telo.Library",
      withEntries({
        "./native/darwin-arm64/addon.node": pinned("addon.node"),
        "./native/linux-amd64/addon.so": { target: "../darwin-arm64/addon.node" },
      }),
    ) as unknown as Array<{ native: unknown[] }>;
    owner[0]!.native.push({
      name: "addon",
      format: "napi",
      os: "darwin",
      arch: "arm64",
      path: "./native/darwin-arm64/addon.node",
    });
    const diagnostics = new StaticAnalyzer()
      .analyze(owner as unknown as ResourceManifest[])
      .filter((d) => d.code.startsWith("SOURCE_"));
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["SOURCE_LINK_TARGET_UNRESOLVED", "sources.addon.entries../native/linux-amd64/addon.so.target"],
    ]);
  });

  it.each(["http://127.0.0.1:8080/{version}.tgz", "http://localhost/{version}.tgz", "http://[::1]/x.tgz"])(
    "accepts plain http to the loopback host in %s",
    (url) => {
      expect(check(withEntries({}, { url }))).toEqual([]);
    },
  );

  it("reports a link chain that never reaches a file at every link on it", () => {
    const sources = withEntries({
      "./native/linux-amd64/addon.so": { target: "addon.so.1" },
      "./native/linux-amd64/addon.so.1": { target: "addon.so" },
    });
    expect(check(sources)).toEqual([
      ["SOURCE_LINK_CYCLE", "sources.addon.entries../native/linux-amd64/addon.so.target"],
      ["SOURCE_LINK_CYCLE", "sources.addon.entries../native/linux-amd64/addon.so.1.target"],
    ]);
  });

  it("says nothing about a dependency's block", () => {
    const sources = withEntries({}, { url: "http://example.test/{os}.tgz" });
    expect(validateSourceEntries(manifests("Telo.Library", sources), new Set(["App"]))).toEqual([]);
  });

  it("reports SOURCE_ENTRY_DUPLICATE when two sources produce one path", () => {
    const second = {
      ...validSource(),
      notices: ["./notices/addon.LICENSE"],
      entries: {
        "./native/linux-amd64/addon.node": { upstream: "linux-x64", member: "addon.node" },
      },
    };
    expect(check({ addon: validSource(), mirror: second })).toEqual([
      ["SOURCE_ENTRY_DUPLICATE", "sources.mirror.entries../native/linux-amd64/addon.node"],
    ]);
  });
});
