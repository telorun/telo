import { describe, expect, it } from "vitest";
import { simpleIndexFiles } from "../src/adapters/pypi.js";

const files = (body: string) => simpleIndexFiles(body, false, "index");

describe("simple index scan", () => {
  it("reads double-quoted, single-quoted and bare hrefs in order, with the sha256 fragment", () => {
    const hash = "a".repeat(64);
    expect(
      files(
        `<a href="a-1.tar.gz#sha256=${hash}">a-1.tar.gz</a>\n<a class=x href='b-1.tar.gz'>b-1.tar.gz</a>\n<a href=c-1.tar.gz>c-1.tar.gz</a >`,
      ),
    ).toEqual([
      { filename: "a-1.tar.gz", href: "a-1.tar.gz", sha256: hash },
      { filename: "b-1.tar.gz", href: "b-1.tar.gz" },
      { filename: "c-1.tar.gz", href: "c-1.tar.gz" },
    ]);
  });

  it("matches tags and attributes case-insensitively, the first href winning", () => {
    expect(files(`<A\tHREF = "x" href="y">f</A\n>`)).toEqual([{ filename: "f", href: "x" }]);
  });

  it("takes the text up to the first closing tag, dropping nested tags, and a quoted href may hold >", () => {
    expect(files(`<a href="p>q"><b>f</b> &amp; g</a></a>`)).toEqual([{ filename: "f & g", href: "p>q" }]);
  });

  it("lists no file for an anchor without href or without a closing tag", () => {
    expect(files(`<a name=x>f</a><a href=x>f`)).toEqual([]);
  });

  it("scans a page of unclosed anchors in linear time", () => {
    const started = Date.now();
    expect(files("<a href=x>".repeat(200_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
