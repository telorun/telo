import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  workspaceAppManifest,
  WORKSPACE_EXCLUDED_DIRECTORIES,
} from "./workspace-app.js";

describe("workspace exclusions", () => {
  it("the manifest's default is the list every backend reads", () => {
    // The tree a backend returns is what the editor diffs against its own
    // files, so the two readers of this set — the workspace application that
    // serves a container session, and a backend that walks a directory itself —
    // have to skip exactly the same names. Kept honest here rather than by
    // hoping two copies stay equal.
    const docs = workspaceAppManifest().split(/^---$/m);
    const application = parse(docs[0]!) as {
      variables?: { excluded?: { default?: string[] } };
    };
    expect(application.variables?.excluded?.default).toEqual([...WORKSPACE_EXCLUDED_DIRECTORIES]);
  });
});
