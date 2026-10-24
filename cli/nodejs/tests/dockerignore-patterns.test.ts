import { selectByPatterns } from "@telorun/glob";
import { describe, expect, it } from "vitest";
import { dockerignorePatterns } from "../src/release/dockerignore-patterns.js";

/**
 * An image module's digest covers exactly the files its Docker ignore file sends
 * to the build. A file Docker leaves out moving the digest is how a release that
 * stamps `chart/Chart.yaml` after recording the ledger re-bumped the hub forever.
 */

const select = (files: string[], ignoreFile: string) =>
  selectByPatterns(files, ["**"], {
    applyDefaultIgnore: false,
    exclude: dockerignorePatterns(ignoreFile, "Dockerfile.dockerignore"),
  });

describe("dockerignorePatterns", () => {
  it("anchors patterns at the root and excludes a named directory's contents", () => {
    const files = [
      "telo.yaml",
      "hub-search.yaml",
      "CHANGELOG.md",
      "Dockerfile",
      "chart/Chart.yaml",
      "chart/templates/deployment.yaml",
      "guides/a.md",
      "guides/sub/b.md",
      "tests/x.yaml",
    ];
    const ignoreFile = "*\n!*.yaml\n!guides/*.md\n\n# comment\ntests\nDockerfile*\ndist/\n";
    expect(select(files, ignoreFile)).toEqual(["guides/a.md", "hub-search.yaml", "telo.yaml"]);
  });

  it("re-includes at any depth through '**'", () => {
    const files = ["telo.yaml", "chat/primer.md", "chat/library.yaml", "src/a.ts"];
    expect(select(files, "*\n!**/*.yaml\n!chat/*.md\n")).toEqual([
      "chat/library.yaml",
      "chat/primer.md",
      "telo.yaml",
    ]);
  });

  it("refuses a character class rather than reading it differently from Docker", () => {
    expect(() => dockerignorePatterns("*\n![a-z].yaml\n", "apps/x/Dockerfile.dockerignore")).toThrow(
      "apps/x/Dockerfile.dockerignore:2:",
    );
  });
});
