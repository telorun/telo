import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { compareCodePoints, FindingOrder, withoutConfigurationClause } from "../src/finding-order.js";
import type { FilePositions } from "../src/position-metadata.js";
import { RuleReports, ruleCarrier, type ReferrerVerdict } from "../src/resource-rule-relation.js";
import type { AnalysisDiagnostic, Range } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const range = (line: number): Range => ({ start: { line, character: 0 }, end: { line, character: 5 } });

/** `file` holding the one document of `kind`/`name`, its places at `lines`. */
function file(source: string, kind: string, name: string, lines: Record<string, number>, sourceLine = 0): FilePositions {
  return {
    source,
    documents: [{ kind, name, position: { sourceLine, positionIndex: new Map(Object.entries(lines).map(([k, v]) => [k, range(v)])) } }],
  };
}

const finding = (code: string, path: string, filePath: string | undefined, message = code): AnalysisDiagnostic => ({
  code,
  message,
  data: { resource: { kind: "A", name: "n" }, ...(filePath ? { filePath } : {}), path },
});

describe("the order findings are reported in", () => {
  it("compares text by code point, not by UTF-16 unit", () => {
    expect(compareCodePoints("\u{1F600}", "～")).toBeGreaterThan(0);
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
  });

  it("reads a message before its configuration clause", () => {
    expect(withoutConfigurationClause("bad (when variables.flag is true; or when variables.flag is absent)")).toBe("bad");
    expect(withoutConfigurationClause("bad (in a branch no configuration takes)")).toBe("bad");
    expect(withoutConfigurationClause("bad")).toBe("bad");
  });

  it("sorts by file, then offset, then path, and puts a finding with no file first", () => {
    const order = new FindingOrder(
      [{ metadata: { source: "/b.yaml" } }, { metadata: { source: "/a.yaml" } }],
      [file("/b.yaml", "A", "n", { zeta: 1, alpha: 5 }), file("/a.yaml", "A", "n", { zeta: 1 })],
    );
    const found = [
      finding("X", "zeta", "/a.yaml"),
      finding("X", "alpha", "/b.yaml"),
      finding("X", "zeta", "/b.yaml"),
      { code: "X", message: "X", data: { path: "zeta" } },
    ];
    expect(order.sort(found).map((d) => (d.data as { filePath?: string }).filePath ?? "none")).toEqual([
      "none",
      "/b.yaml",
      "/b.yaml",
      "/a.yaml",
    ]);
    // The file's first document is where the written offsets are, not the path text.
    expect(order.sort(found).map((d) => (d.data as { path: string }).path).slice(1, 3)).toEqual(["zeta", "alpha"]);
  });

  it("falls to the nearest written ancestor, and to the path text with no position table", () => {
    const order = new FindingOrder([{ metadata: { source: "/f.yaml" } }], [file("/f.yaml", "A", "n", { a: 3, b: 1 })]);
    const [first] = order.sort([finding("X", "a.deep", "/f.yaml"), finding("X", "b.deep", "/f.yaml")]);
    expect((first!.data as { path: string }).path).toBe("b.deep");
    const bare = new FindingOrder([], undefined);
    expect(bare.sort([finding("X", "b", "/f.yaml"), finding("X", "a", "/f.yaml")]).map((d) => (d.data as { path: string }).path)).toEqual(["a", "b"]);
  });

  it("names the earliest written declaration as the one a duplicate collides with, whatever the list order", () => {
    const declare = (line: number): ResourceManifest =>
      ({ kind: "Telo.Application", metadata: { name: "Same", source: "/m.yaml", sourceLine: line } }) as unknown as ResourceManifest;
    const lines = (line: number) => ({ sourceLine: line, positionIndex: new Map([["metadata.name", range(line + 1)]]) });
    const positions: FilePositions[] = [
      {
        source: "/m.yaml",
        documents: [
          { kind: "Telo.Application", name: "Same", position: lines(2) },
          { kind: "Telo.Application", name: "Same", position: lines(10) },
        ],
      },
    ];
    const reportedAt = (manifests: ResourceManifest[]) =>
      new StaticAnalyzer()
        .analyze(withSyntheticPositions(manifests), { positions })
        .filter((d) => d.code === "DUPLICATE_RESOURCE_NAME")
        .map((d) => d.range?.start.line);
    expect(reportedAt([declare(2), declare(10)])).toEqual([10]);
    expect(reportedAt([declare(10), declare(2)])).toEqual([10]);
  });

  it("settles a referrer rule's first failure on a resource in written order, whatever order its verdicts arrive in", () => {
    const holder = (name: string) => ({ kind: "A", metadata: { name, source: "/m.yaml" } }) as unknown as ResourceManifest;
    const at = (name: string, path: string) => ({ kind: "A", name, filePath: "/m.yaml", path });
    const carrier = (name: string, path: string, message: string): AnalysisDiagnostic => {
      const verdict: ReferrerVerdict = {
        type: "referrer",
        claim: `${name}\0${path}`,
        at: at(name, path),
        subject: "subject",
        failure: {
          type: "failure",
          key: "k",
          rule: "r",
          module: undefined,
          report: {
            code: "REFERRER_RULE_INVALID",
            severity: "error",
            message,
            definition: { kind: "Telo.Definition", name: "D", source: "/m.yaml" },
            path: undefined,
          },
        },
      };
      return ruleCarrier(holder(name), verdict, path);
    };
    const positions: FilePositions[] = [
      { source: "/m.yaml", documents: [
        { kind: "A", name: "early", position: { sourceLine: 1, positionIndex: new Map() } },
        { kind: "A", name: "late", position: { sourceLine: 20, positionIndex: new Map() } },
      ] },
    ];
    const order = new FindingOrder([{ metadata: { source: "/m.yaml" } }], positions);
    const early = carrier("early", "x", "seen at early");
    const late = carrier("late", "x", "seen at late");
    const reported = (list: AnalysisDiagnostic[]) =>
      new RuleReports(() => undefined, order).settle(list).map((d) => d.message);
    expect(reported([late, early])).toEqual(["seen at early"]);
    expect(reported([early, late])).toEqual(["seen at early"]);
  });
});
