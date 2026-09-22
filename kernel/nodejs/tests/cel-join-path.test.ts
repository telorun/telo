import path from "node:path";
import { describe, expect, it } from "vitest";
import { joinPathWith } from "../src/cel-handlers.js";

/**
 * `joinPath` joins under the HOST's path rules. Both platforms' rules are
 * exercised here through Node's own `path.win32` / `path.posix`, since the
 * test itself runs on one host only.
 */
describe("joinPath", () => {
  it("joins with backslashes on Windows, accepting a relative path written with /", () => {
    const join = joinPathWith(path.win32);
    expect(join("C:\\data", "reports/daily")).toBe("C:\\data\\reports\\daily");
    expect(join("\\\\server\\share\\data", "out")).toBe("\\\\server\\share\\data\\out");
  });

  it("joins with slashes elsewhere", () => {
    expect(joinPathWith(path.posix)("/srv/data", "reports/daily")).toBe("/srv/data/reports/daily");
  });

  it("refuses an absolute argument on either platform's reading", () => {
    for (const rules of [path.win32, path.posix]) {
      const join = joinPathWith(rules);
      expect(() => join("/srv/data", "/etc")).toThrow(/is an absolute path/);
      expect(() => join("C:\\data", "D:\\other")).toThrow(/is an absolute path/);
    }
  });
});
