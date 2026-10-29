import { describe, expect, it } from "vitest";
import { artifactPath, nestedOciRef, parseOciRef } from "../src/sources/oci-ref.js";

const HEX = "ab".repeat(32);

describe("parseOciRef", () => {
  it("refuses a tag spelled like a digest, naming the ref", () => {
    expect(() => parseOciRef(`oci://h/r@sha256-${HEX}`)).toThrow(`oci://h/r@sha256-${HEX}`);
    expect(parseOciRef("oci://h/r@sha256-abc").reference).toBe("sha256-abc");
  });

  it("reads a path after a digest reference as a module inside the artifact", () => {
    expect(parseOciRef(`oci://h/r@sha256:${HEX}/chat`)).toEqual({
      host: "h",
      repo: "r",
      reference: `sha256:${HEX}`,
      path: "chat",
    });
    expect(parseOciRef(`oci://h/r@sha256:${HEX}/a/b.yaml`).path).toBe("a/b.yaml");
  });

  it("keeps a repository path and a tag as before", () => {
    expect(parseOciRef("oci://h/r/chat")).toEqual({ host: "h", repo: "r/chat", reference: "latest" });
    expect(parseOciRef("oci://h/r@1.2.0")).toEqual({ host: "h", repo: "r", reference: "1.2.0" });
    expect(parseOciRef(`oci://h/r@sha256:${HEX}`)).toEqual({
      host: "h",
      repo: "r",
      reference: `sha256:${HEX}`,
    });
  });

  it("reads the pin fragment after the path", () => {
    expect(parseOciRef(`oci://h/r@sha256:${HEX}/chat#sha256-pin`)).toEqual({
      host: "h",
      repo: "r",
      reference: `sha256:${HEX}`,
      path: "chat",
      integrity: "sha256-pin",
    });
  });

  it("refuses a path that does not name a module inside the artifact", () => {
    expect(() => parseOciRef(`oci://h/r@sha256:${HEX}/../escape`)).toThrow(/path after the digest/);
    expect(() => parseOciRef(`oci://h/r@sha256:${HEX}/a//b`)).toThrow(/path after the digest/);
  });

  it("round-trips the identity it builds", () => {
    const ref = nestedOciRef({ host: "h", repo: "a/r", digest: `sha256:${HEX}` }, "chat");
    expect(ref).toBe(`oci://h/a/r@sha256:${HEX}/chat`);
    expect(parseOciRef(ref)).toMatchObject({ repo: "a/r", path: "chat" });
  });
});

describe("artifactPath", () => {
  it("resolves a relative import inside the artifact as on disk", () => {
    expect(artifactPath("", "./chat")).toBe("chat");
    expect(artifactPath("chat", "../ordering.yaml")).toBe("ordering.yaml");
    expect(artifactPath("a/b", "./c/../d")).toBe("a/b/d");
  });

  it("is null for a path leaving the artifact root, or an absolute one", () => {
    expect(artifactPath("", "../shared")).toBeNull();
    expect(artifactPath("chat", "../../shared")).toBeNull();
    expect(artifactPath("", "/abs")).toBeNull();
  });
});
