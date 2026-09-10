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

  it("declares no blocks — a session reads none of them", () => {
    // It used to write `modules: ["*"]`, release scope a session has no use
    // for, purely because an empty list was a parse error. A marker whose whole
    // content is comments is valid, so the runner stops shipping a fabricated
    // claim into every user's workspace.
    expect(WORKSPACE_MARKER_CONTENTS.split("\n").filter((line) => line.trim() !== "")).toEqual(
      expect.arrayContaining([expect.stringMatching(/^#/)]),
    );
    expect(WORKSPACE_MARKER_CONTENTS).not.toMatch(/^[A-Za-z]/m);
  });
});
