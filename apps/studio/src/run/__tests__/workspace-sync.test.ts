import { describe, expect, it } from "vitest";

import { bundleFiles, diffBundle, isEmptyChangeSet } from "../workspace-sync";

const files = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe("diffBundle", () => {
  it("writes only what changed", () => {
    // The watcher fires on a write, so an unconditional re-push would reload
    // every app on every save — including one that never reads the saved file.
    const changes = diffBundle(
      files({ "telo.yaml": "a", "lib/x.yaml": "b" }),
      files({ "telo.yaml": "a", "lib/x.yaml": "B" }),
    );
    expect(changes.write).toEqual([{ path: "lib/x.yaml", content: "B" }]);
    expect(changes.delete).toBeUndefined();
  });

  it("writes a file that did not exist before", () => {
    const changes = diffBundle(files({ "telo.yaml": "a" }), files({ "telo.yaml": "a", "new.yaml": "n" }));
    expect(changes.write).toEqual([{ path: "new.yaml", content: "n" }]);
  });

  it("deletes a file that left the bundle", () => {
    // A watch workspace is long-lived, so a deleted file has to actually leave
    // it — a write list cannot express that.
    const changes = diffBundle(files({ "telo.yaml": "a", "gone.yaml": "g" }), files({ "telo.yaml": "a" }));
    expect(changes.delete).toEqual(["gone.yaml"]);
    expect(changes.write).toBeUndefined();
  });

  it("is empty when nothing moved", () => {
    const same = files({ "telo.yaml": "a" });
    expect(isEmptyChangeSet(diffBundle(same, files({ "telo.yaml": "a" })))).toBe(true);
  });

  it("treats a first sync as writing everything", () => {
    const changes = diffBundle(new Map(), files({ "telo.yaml": "a", "b.yaml": "b" }));
    expect(changes.write).toHaveLength(2);
    expect(isEmptyChangeSet(changes)).toBe(false);
  });
});

describe("bundleFiles", () => {
  it("keys a bundle by its relative paths", () => {
    const map = bundleFiles({
      entryRelativePath: "telo.yaml",
      files: [
        { relativePath: "telo.yaml", contents: "a" },
        { relativePath: "sub/b.yaml", contents: "b" },
      ],
    });
    expect([...map.entries()]).toEqual([
      ["telo.yaml", "a"],
      ["sub/b.yaml", "b"],
    ]);
  });
});
