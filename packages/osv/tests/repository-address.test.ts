import { describe, expect, it } from "vitest";
import { sameRepository, vcsRepository } from "../src/index.js";
import { stripTrailingSlashes } from "../src/repository-address.js";

describe("repository addresses", () => {
  it("normalizes scheme and host, trailing slashes and .git, keeping the path as written", () => {
    expect(vcsRepository("git+HTTPS://GitHub.com/Acme/Engine.git/")).toBe("https://github.com/Acme/Engine");
    expect(vcsRepository("https://Example.com")).toBe("https://example.com");
    expect(vcsRepository("git@github.com:acme/engine.git")).toBe("git@github.com:acme/engine");
    expect(vcsRepository("1x://Host/p")).toBe("1x://Host/p");
    expect(sameRepository("https://github.com/acme/engine/", "HTTPS://GITHUB.com/acme/engine.git")).toBe(true);
    expect(sameRepository("https://github.com/acme/engine", "https://github.com/acme/Engine")).toBe(false);
  });

  it("strips every trailing slash and nothing else", () => {
    expect(stripTrailingSlashes("https://osv.test///")).toBe("https://osv.test");
    expect(stripTrailingSlashes("/a/b")).toBe("/a/b");
    expect(stripTrailingSlashes("////")).toBe("");
  });

  it("answers long adversarial input quickly", () => {
    const started = Date.now();
    stripTrailingSlashes(`x${"/".repeat(100_000)}`);
    vcsRepository(`${"/".repeat(100_000)}x`);
    vcsRepository(`a://${".".repeat(100_000)}`);
    vcsRepository(`${"a".repeat(100_000)}://h/${"/".repeat(100_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
