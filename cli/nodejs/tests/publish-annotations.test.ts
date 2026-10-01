import { describe, expect, it } from "vitest";
import { parseAnnotationFlags } from "../src/publish-annotations.js";

describe("parseAnnotationFlags", () => {
  it("splits each flag at its first '='", () => {
    expect(parseAnnotationFlags(["com.example.note=a=b", "com.example.empty="])).toEqual({
      "com.example.note": "a=b",
      "com.example.empty": "",
    });
  });

  it("refuses a flag with no '='", () => {
    expect(() => parseAnnotationFlags(["com.example.note"])).toThrow(/write it as <key>=<value>/);
  });

  it("refuses a key that is not reverse-domain", () => {
    for (const key of ["note", "com..note", "com.example.", "-com.example", "com.exa mple"]) {
      expect(() => parseAnnotationFlags([`${key}=x`])).toThrow(/not a reverse-domain name/);
    }
  });

  it("refuses a key given twice", () => {
    expect(() => parseAnnotationFlags(["com.example.note=a", "com.example.note=b"])).toThrow(
      /given twice/,
    );
  });
});
