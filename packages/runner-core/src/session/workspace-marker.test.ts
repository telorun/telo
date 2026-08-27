import { describe, expect, it } from "vitest";

import type { RunBundle } from "../contract.js";
import {
  WORKSPACE_MARKER_CONTENTS,
  WORKSPACE_MARKER_FILENAME,
  workspaceMarkerWrite,
} from "./workspace-marker.js";

const bundle = (paths: string[]): RunBundle => ({
  entryRelativePath: "telo.yaml",
  files: paths.map((relativePath) => ({ relativePath, contents: "x" })),
});

describe("workspaceMarkerWrite", () => {
  it("seeds the marker at the workspace root", () => {
    // Its LOCATION is what anchors the cache: the kernel walks up from an app's
    // entry manifest, so the marker has to sit at the root, not beside an app.
    expect(workspaceMarkerWrite(bundle(["telo.yaml", "worker.yaml"]))).toEqual([
      { path: WORKSPACE_MARKER_FILENAME, content: WORKSPACE_MARKER_CONTENTS },
    ]);
  });

  it("leaves a workspace that brings its own marker alone", () => {
    // A project that really is a Telo workspace has a marker with a real
    // `modules:` list; overwriting it would change what `telo release` finds.
    expect(workspaceMarkerWrite(bundle(["telo.yaml", WORKSPACE_MARKER_FILENAME]))).toEqual([]);
  });

  it("writes a marker the workspace parser accepts", () => {
    // An empty `modules:` is a hard error in that parser, so a marker seeded
    // with one would be a file this repo's own tooling rejects.
    expect(WORKSPACE_MARKER_CONTENTS).toMatch(/^modules: \[.+\]$/m);
  });
});
