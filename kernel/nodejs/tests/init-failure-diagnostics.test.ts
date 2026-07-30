import type { RuntimeDiagnostic } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import {
  classifyInitFailures,
  describeBlockedGroup,
  groupBlockedResources,
  renderInitFailureText,
  summarizeInitFailures,
  type FailedResource,
} from "../src/init-failure-diagnostics.js";

const failure = (
  resource: string,
  deps: string[],
  extra: Partial<FailedResource> = {},
): FailedResource => ({ resource, message: `${resource} failed`, deps, ...extra });

describe("classifyInitFailures", () => {
  it("never collapses an entry that has an independent error of its own", () => {
    // Api references the failed Db AND fails its own schema validation. The
    // edge must not swallow the schema error — the author would fix Db, rerun,
    // and only then discover the second, unrelated failure.
    const diagnostics = classifyInitFailures([
      failure("Db", [], { message: "connect ECONNREFUSED" }),
      failure("Api", ["Db"], { code: "ERR_MANIFEST_VALIDATION_FAILED", message: "/port must be integer" }),
    ]);
    expect(diagnostics.map((d) => [d.resource, d.derived ?? false])).toEqual([
      ["Db", false],
      ["Api", false],
    ]);
    expect(renderInitFailureText(diagnostics)).toContain("/port must be integer");
  });

  it("attributes a deferral THROUGH an independently-failed entry to that entry", () => {
    const diagnostics = classifyInitFailures([
      failure("Db", [], { message: "refused" }),
      failure("Api", ["Db"], { code: "ERR_MANIFEST_VALIDATION_FAILED" }),
      failure("Route", ["Api"], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);
    // Api is a root cause of its own, so the chain stops there, not at Db.
    expect(diagnostics.find((d) => d.resource === "Route")).toMatchObject({
      derived: true,
      blockedBy: "Api",
    });
  });

  it("keeps the only independent failure as the root and marks the chain derived", () => {
    const diagnostics = classifyInitFailures([
      failure("GrantStore", ["GrantDb"], { code: "ERR_LOCAL_REF_PENDING" }),
      failure("GoogleTokens", ["GrantStore"], { code: "ERR_LOCAL_REF_PENDING" }),
      failure("GrantDb", [], { code: "28P01", message: "password authentication failed" }),
    ]);

    expect(diagnostics.map((d) => [d.resource, d.derived ?? false, d.blockedBy])).toEqual([
      ["GrantDb", false, undefined],
      ["GrantStore", true, "GrantDb"],
      ["GoogleTokens", true, "GrantDb"],
    ]);
  });

  it("attributes a chain to its ROOT, not the immediate blocker", () => {
    const [, , third] = classifyInitFailures([
      failure("A", []),
      failure("B", ["A"], { code: "ERR_LOCAL_REF_PENDING" }),
      failure("C", ["B"], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);
    expect(third).toMatchObject({ resource: "C", blockedBy: "A" });
  });

  it("treats a cross-module ref as depending on the import alias's own resource", () => {
    const diagnostics = classifyInitFailures([
      failure("SheetRows", [], { kind: "Telo.Import" }),
      failure("Main", ["SheetRows"], { code: "ERR_CROSS_MODULE_REF_PENDING" }),
    ]);
    expect(diagnostics.find((d) => d.resource === "Main")).toMatchObject({
      derived: true,
      blockedBy: "SheetRows",
    });
  });

  it("marks a pending-code entry derived even when no visible edge names the blocker", () => {
    // The edge is a `${{ resources.X }}` CEL read, invisible to the ref walk.
    const diagnostics = classifyInitFailures([
      failure("Db", [], { message: "connect ECONNREFUSED" }),
      failure("Consumer", [], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);
    const consumer = diagnostics.find((d) => d.resource === "Consumer");
    expect(consumer?.derived).toBe(true);
    expect(consumer?.blockedBy).toBeUndefined();
  });

  it("reports everything unclassified when nothing survives as a root", () => {
    const diagnostics = classifyInitFailures([
      failure("A", ["B"], { code: "ERR_LOCAL_REF_PENDING" }),
      failure("B", ["A"], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);
    expect(diagnostics.every((d) => !d.derived)).toBe(true);
  });

  it("leaves independent failures as separate roots", () => {
    const diagnostics = classifyInitFailures([
      failure("Db", [], { message: "refused" }),
      failure("Cache", [], { message: "refused" }),
    ]);
    expect(diagnostics.filter((d) => d.derived)).toHaveLength(0);
  });

  it("carries nested child diagnostics through unchanged", () => {
    const children = [{ message: "inner", resource: "GrantDb" }];
    const [only] = classifyInitFailures([failure("SheetRows", [], { children })]);
    expect(only.children).toBe(children);
  });
});

describe("groupBlockedResources", () => {
  it("groups each chain under its root cause and renders one line per group", () => {
    const diagnostics = classifyInitFailures([
      failure("Db", [], { message: "refused" }),
      failure("Store", ["Db"], { code: "ERR_LOCAL_REF_PENDING" }),
      failure("Reader", ["Store"], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);
    const groups = [...groupBlockedResources(diagnostics)];
    expect(groups).toEqual([["Db", ["Store", "Reader"]]]);
    expect(describeBlockedGroup("Db", ["Store", "Reader"])).toBe(
      "2 resources blocked by Db: Store, Reader",
    );
  });

  it("names an unattributable group without inventing a blocker", () => {
    expect(describeBlockedGroup(undefined, ["Consumer"])).toBe(
      "1 resource blocked by an uninitialized dependency: Consumer",
    );
  });
});

describe("renderInitFailureText", () => {
  const chain = (prefix: string) =>
    classifyInitFailures([
      failure(`${prefix}Db`, [], { message: "connect ECONNREFUSED" }),
      failure(`${prefix}Store`, [`${prefix}Db`], { code: "ERR_LOCAL_REF_PENDING" }),
      failure(`${prefix}Work`, [`${prefix}Store`], { code: "ERR_LOCAL_REF_PENDING" }),
    ]);

  it("prints each root in full and each chain as exactly one group line", () => {
    const lines = renderInitFailureText(chain("")).split("\n");
    expect(lines).toEqual([
      "  Db: connect ECONNREFUSED",
      "  2 resources blocked by Db: Store, Work",
    ]);
  });

  it("traverses a nested child list exactly once — no duplicated group lines", () => {
    const outer: RuntimeDiagnostic[] = [
      { resource: "Lib", kind: "Telo.Import", message: "3 resources failed", children: chain("") },
    ];
    const lines = renderInitFailureText(outer).split("\n");
    expect(lines.filter((l) => l.includes("blocked by Db"))).toEqual([
      "    2 resources blocked by Db: Store, Work",
    ]);
  });

  it("still reports a nested context's roots when the wrapping entry is collapsed", () => {
    const [wrapper] = classifyInitFailures([
      failure("Lib", [], { code: "ERR_LOCAL_REF_PENDING", children: chain("") }),
    ]);
    // The wrapper alone would classify as a root (nothing else failed here);
    // force the collapsed shape to assert children survive it.
    const text = renderInitFailureText([{ ...wrapper, derived: true, blockedBy: "Other" }]);
    expect(text).toContain("Db: connect ECONNREFUSED");
  });
});

describe("summarizeInitFailures", () => {
  it("counts roots against the total when part of the set is collapsed", () => {
    expect(summarizeInitFailures(chainOf3())).toBe(
      "3 resources failed to initialize (1 root cause, rest blocked)",
    );
  });

  it("omits the breakdown when every failure is independent", () => {
    const diagnostics = classifyInitFailures([failure("A", []), failure("B", [])]);
    expect(summarizeInitFailures(diagnostics)).toBe("2 resources failed to initialize");
  });
});

function chainOf3() {
  return classifyInitFailures([
    failure("Db", [], { message: "refused" }),
    failure("Store", ["Db"], { code: "ERR_LOCAL_REF_PENDING" }),
    failure("Work", ["Store"], { code: "ERR_LOCAL_REF_PENDING" }),
  ]);
}
