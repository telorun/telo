import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `telo describe`, end to end: what an application does, read from its
 *  manifest with nothing booted. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const FIXTURES = path.join(ROOT, "cli/nodejs/tests/__fixtures__/describe");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args].map(quote), {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: VIA_CMD,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), status: err.status ?? 1 };
  }
}

/** The index of the first line at or after `from` matching `pattern`. */
const lineIndex = (lines: string[], pattern: RegExp, from = 0) =>
  lines.findIndex((line, i) => i >= from && pattern.test(line));
const indentOf = (line: string) => line.length - line.trimStart().length;

describe("telo describe", () => {
  const fixture = path.join(FIXTURES, "order-webhook");

  it("prints what the application does, each resource expanded once", () => {
    const { stdout, status } = runCli(["describe", fixture]);
    expect(status).toBe(0);
    const lines = stdout.split("\n");
    expect(lines.filter((line) => /^[A-Z][a-z ]+$/.test(line))).toEqual([
      "Inputs",
      "Boot",
      "Entry points",
      "Resources",
      "Unreached",
    ]);
    expect(lines).toContain(
      "  server › mounts path=/webhooks › mount › webhookRoutes › routes path=/orders method=POST › handler → handleDelivery  [trigger.inbound]",
    );
    expect(lines).toContain("    ERR_CLAIM_LOST  routes[0].catches[1]");

    // The route sits beneath the mount that serves it.
    const mount = lineIndex(lines, /mounts path=\/webhooks$/);
    const route = lineIndex(lines, /routes path=\/orders method=POST$/, mount);
    expect(mount).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(mount);
    expect(indentOf(lines[route]!)).toBeGreaterThan(indentOf(lines[mount]!));

    // Both branches of the `if`, beneath the predicate as written.
    const predicate = lineIndex(lines, /rejectUnknownSender {2}if !cel "inputs\.token != 'Bearer ' \+ secrets\.webhookToken" : bool$/);
    expect(predicate).toBeGreaterThan(-1);
    const then = lineIndex(lines, /^\s*then:$/, predicate);
    const otherwise = lineIndex(lines, /^\s*else:$/, then);
    expect(indentOf(lines[then]!)).toBeGreaterThan(indentOf(lines[predicate]!));
    expect(indentOf(lines[otherwise]!)).toBe(indentOf(lines[then]!));

    expect(lines.some((line) => /invoke every=!cel "variables\.sweepEvery" : string → shipPending/.test(line))).toBe(true);
    // A resource reached again is named, not expanded twice.
    expect(lines.filter((line) => /→ db {2}SQLite\.Connection {2}\[dependency\]$/.test(line))).toHaveLength(1);
    expect(lines.some((line) => /→ db {2}SQLite\.Connection {2}\[dependency\] {2}\(see above\)$/.test(line))).toBe(true);
  });

  it("prints the outline document under -o json, a secret's default nowhere in it", () => {
    const { stdout, status } = runCli(["describe", "-o", "json", fixture]);
    expect(status).toBe(0);
    expect(stdout).not.toContain("local-dev-token");
    const outline = JSON.parse(stdout);
    expect(outline.outlineVersion).toBe(1);
    expect(outline.inputs.find((i: any) => i.name === "webhookToken")).toEqual({
      block: "secrets",
      name: "webhookToken",
      binding: { env: "WEBHOOK_TOKEN" },
      type: "string",
      required: false,
      readBy: [{ resource: "OrderWebhook\u0000Run.Sequence\u0000handleDelivery", path: "steps[0].if" }],
    });
    expect(outline.entryPoints.find((e: any) => e.handlerName === "shipPending").match).toEqual({
      every: { tag: "cel", source: "variables.sweepEvery", type: "string" },
    });
    expect(outline.unreached.map((u: any) => u.name)).toEqual(["audit"]);

    // A controller-backed leaf is its kind, contract, throws and deprecation —
    // never its configuration — whichever controller backs it.
    const leaf = (name: string) => outline.resources.find((r: any) => r.name === name);
    const fields = ["id", "name", "kind", "canonicalKind", "module", "capability", "deprecated", "rows", "edges"];
    expect(Object.keys(leaf("stamp")).sort()).toEqual([...fields].sort());
    expect(Object.keys(leaf("exec")).sort()).toEqual(fields.filter((f) => f !== "deprecated").sort());
    expect(leaf("stamp").deprecated.reason).toContain("Inline JavaScript");
  });

  it("prints a literal mapping apart from the expression it spells, a string inside a list or a mapping quoted", () => {
    const vector = path.join(ROOT, "analyzer/outline-conformance/vectors/written-values");
    const { stdout, status } = runCli(["describe", vector]);
    expect(status).toBe(0);
    const lines = stdout.split("\n").map((line) => line.trim());
    expect(lines).toContain('inputs {literal: {tag: "cel", source: "1+1"}, expression: !cel "1+1" : int}');
    expect(lines.some((line) => line.includes('topics=["orders", {tag: "cel", source: "1+1"}]'))).toBe(true);
  });

  it("gives no outline for a manifest telo check refuses", () => {
    const { stdout, stderr, status } = runCli(["describe", path.join(FIXTURES, "broken")]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("UNRESOLVED_REFERENCE");
  });

  it("names the variables telo needs report names", () => {
    const needs = path.join(FIXTURES, "needs");
    const report = JSON.parse(runCli(["needs", "report", "-o", "json", needs]).stdout);
    const outline = JSON.parse(runCli(["describe", "-o", "json", needs]).stdout);
    const fromReport = report.needs.flatMap((n: any) => Object.values(n.fields).map((f: any) => f.env));
    const fromOutline = outline.inputs
      .filter((i: any) => i.block === "needs")
      .flatMap((i: any) => Object.values(i.fields).map((f: any) => f.env));
    expect(fromOutline).toEqual(fromReport);
    expect(fromOutline).toEqual([
      "SESSION_KEY",
      "TELO_NEED_ORDERS__DATABASE_ACCESS__URL",
      "TELO_NEED_ORDERS__DATABASE_ACCESS__SCHEMA",
      "TELO_NEED_AUDIT__TRAIL__URL",
      "TELO_NEED_AUDIT__TRAIL__SCHEMA",
    ]);
  });
});
