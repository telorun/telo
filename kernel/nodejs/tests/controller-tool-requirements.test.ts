import { describe, expect, it } from "vitest";
import {
  isCommandNotFound,
  missingToolMessage,
  packageManagerName,
  toolRequirement,
} from "../src/controller-loaders/controller-tool-requirements.js";

/**
 * What "the tool is not there" is allowed to be decided from.
 *
 * The cost of getting this wrong is asymmetric, which is what these cases pin
 * down: a false positive reclassifies a real failure as env-missing, and on the
 * cargo path that means the dispatcher falls through to the next candidate and
 * the compiler's diagnosis is discarded.
 */
describe("isCommandNotFound", () => {
  it("recognises the shapes a missing program actually produces", () => {
    expect(isCommandNotFound(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }))).toBe(
      true,
    );
    // A shell resolves itself, so the miss arrives as the shell's exit code.
    expect(isCommandNotFound(Object.assign(new Error("Command failed"), { code: 9009 }))).toBe(true);
    expect(isCommandNotFound(Object.assign(new Error("Command failed"), { status: 127 }))).toBe(
      true,
    );
  });

  it("does not read a tool's own output as a missing tool", () => {
    // npm about a package that does not exist. Read as "npm is missing", the
    // author is told to install Node.js for a misspelled dependency.
    const missingPackage = Object.assign(
      new Error("Command failed: npm install --loglevel=error"),
      {
        code: 1,
        stderr: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@acme/nope",
      },
    );
    expect(isCommandNotFound(missingPackage)).toBe(false);

    // cargo about a broken toolchain. Read as env-missing, the build failure
    // becomes a fallthrough and the run ends with a generic "no controller".
    const brokenLinker = Object.assign(new Error("Command failed: cargo build --release"), {
      code: 101,
      stderr: "error: linker `cc` not found\n  |\n  = note: No such file or directory",
    });
    expect(isCommandNotFound(brokenLinker)).toBe(false);
  });

  it("treats anything unrecognisable as present", () => {
    expect(isCommandNotFound(undefined)).toBe(false);
    expect(isCommandNotFound(new Error("timed out"))).toBe(false);
    expect(isCommandNotFound(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
  });
});

describe("toolRequirement", () => {
  it("names the package manager for an npm-delivered controller", () => {
    const requirement = toolRequirement("pkg:npm/@telorun/pdf@0.8.0?local_path=./nodejs#text", {});
    expect(requirement?.tool).toBe("npm");
    expect(missingToolMessage(requirement!, "A controller")).toContain("Install Node.js");
  });

  it("follows TELO_PKG_MANAGER, so the message names what was looked for", () => {
    const env = { TELO_PKG_MANAGER: "pnpm" };
    expect(packageManagerName(env)).toBe("pnpm");
    expect(toolRequirement("pkg:npm/x@1", env)?.tool).toBe("pnpm");
  });

  it("names cargo for a crate controller", () => {
    expect(toolRequirement("pkg:cargo/telo-console?local_path=./rust#writeLine", {})?.tool).toBe(
      "cargo",
    );
  });

  it("asks for nothing for a bundled controller — the standard library's shape", () => {
    expect(
      toolRequirement("pkg:telo/local/js?path=./nodejs/console.mjs#writeLine", {}),
    ).toBeUndefined();
    expect(toolRequirement("not a purl", {})).toBeUndefined();
  });
});
