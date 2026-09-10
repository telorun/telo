import { lastMatchIndex } from "@telorun/glob";
import { describe, expect, it } from "vitest";
import { workspaceCompletions, workspaceDiagnostics } from "../src/workspace/workspace-marker.js";

const env = (over: Partial<Parameters<typeof workspaceDiagnostics>[1]> = {}) => ({
  match: lastMatchIndex,
  ...over,
});

describe("marker diagnostics", () => {
  it("anchors each one on its own key", () => {
    const text = ["release:", "  registry: 7", "  nope: 1", ""].join("\n");
    const found = workspaceDiagnostics(text);

    expect(found.map((d) => [d.code, d.range.start.line])).toEqual([
      ["WORKSPACE_UNKNOWN_KEY", 2],
      ["WORKSPACE_INVALID_VALUE", 1],
    ]);
  });

  it("reports the moved key once, not a cascade of unknown ones", () => {
    const found = workspaceDiagnostics("modules:\n  - modules/*\n");
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe("WORKSPACE_MODULES_MOVED");
    expect(found[0].range.start.line).toBe(0);
  });

  it("says nothing about a marker that is all comments", () => {
    expect(workspaceDiagnostics("# just an anchor\n")).toEqual([]);
  });

  it("names an entry that discovers no module", () => {
    const text = "release:\n  modules:\n    - modules/*\n    - tooling/*\n";
    const found = workspaceDiagnostics(
      text,
      env({ moduleDirectories: () => ["modules/sql", "modules/ai"] }),
    );

    expect(found.map((d) => d.code)).toEqual(["WORKSPACE_ENTRY_MATCHES_NOTHING"]);
    expect(found[0].range.start.line).toBe(3);
  });

  it("distinguishes an entry a later one shadows from one that matches nothing", () => {
    // Last-match-wins makes the first entry inert rather than absent, and the
    // two want different fixes, so they are different diagnostics.
    const text = "release:\n  modules:\n    - modules/*\n    - modules/**\n";
    const found = workspaceDiagnostics(
      text,
      env({ moduleDirectories: () => ["modules/sql"] }),
    );

    expect(found.map((d) => d.code)).toEqual(["WORKSPACE_ENTRY_SHADOWED"]);
    expect(found[0].message).toContain("modules/**");
  });

  it("reports a marker nested under another", () => {
    const found = workspaceDiagnostics(
      "release:\n  modules:\n    - apps/*\n",
      env({ moduleDirectories: () => ["apps/one"], enclosingMarkers: () => ["/repo"] }),
    );
    expect(found.map((d) => d.code)).toEqual(["WORKSPACE_MARKER_SHADOWED"]);
  });

  it("skips the repo-shaped checks with no environment", () => {
    expect(workspaceDiagnostics("release:\n  modules:\n    - tooling/*\n")).toEqual([]);
  });
});

describe("marker completion", () => {
  it("offers the blocks at the top level", () => {
    const items = workspaceCompletions("", { line: 0, character: 0 });
    expect(items.map((i) => i.label)).toEqual(["release", "env"]);
  });

  it("offers a block's own keys inside it", () => {
    const text = "release:\n  \n";
    const items = workspaceCompletions(text, { line: 1, character: 2 });
    expect(items.map((i) => i.label)).toEqual(["registry", "ignore", "modules"]);
  });

  it("offers directories holding a manifest under release.modules", () => {
    const text = "release:\n  modules:\n    - \n";
    const items = workspaceCompletions(
      text,
      { line: 2, character: 6 },
      env({ moduleDirectories: () => ["modules/sql", "apps/hub"] }),
    );
    expect(items.map((i) => i.label)).toEqual(["modules/sql", "apps/hub"]);
  });

  it("offers the ledger's recorded base at release.registry", () => {
    const text = "release:\n  registry: \n";
    const items = workspaceCompletions(
      text,
      { line: 1, character: 12 },
      env({ recordedRegistries: () => ["oci://ghcr.io/telorun"] }),
    );
    expect(items.map((i) => i.label)).toEqual(["oci://ghcr.io/telorun"]);
  });

  it("keeps the key completions when no directory listing is supplied", () => {
    const items = workspaceCompletions("env:\n  \n", { line: 1, character: 2 });
    expect(items.map((i) => i.label)).toEqual(["roots", "files"]);
  });

  it("reads a flow mapping, which a line scanner cannot see", () => {
    const text = "release: {registry: oci://x/y, modules: [a]}\n";
    const items = workspaceCompletions(
      text,
      // Inside the flow sequence at `[a]`.
      { line: 0, character: 41 },
      env({ moduleDirectories: () => ["modules/sql"] }),
    );
    expect(items.map((i) => i.label)).toEqual(["modules/sql"]);
  });

  it("offers an entry's own keys inside a modules entry", () => {
    const text = "release:\n  modules:\n    - path: vendor/aws/*\n      \n";
    const items = workspaceCompletions(text, { line: 3, character: 6 });
    expect(items.map((i) => i.label)).toEqual(["path", "registry", "ignore"]);
  });
});

describe("an entry that claims nothing", () => {
  it("says so differently when a later negation is what emptied it", () => {
    // "matches no directory holding a telo.yaml" would be factually wrong here
    // and would send the author hunting for a typo in a correct pattern.
    const text = "release:\n  modules:\n    - modules/*\n    - '!modules/**'\n";
    const found = workspaceDiagnostics(
      text,
      env({ moduleDirectories: () => ["modules/sql"] }),
    );
    expect(found.map((d) => d.code)).toEqual(["WORKSPACE_ENTRY_SHADOWED"]);
    expect(found[0].message).toContain("excluded by");
  });
});
