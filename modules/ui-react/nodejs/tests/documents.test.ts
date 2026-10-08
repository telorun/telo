import { describe, expect, it } from "vitest";
import { holdsCurrent, servedDocument } from "../src/documents.js";
import { shellHtml } from "../src/shell.js";

describe("a served document", () => {
  it("has a digest that depends on what it holds and not on key order", () => {
    const one = servedDocument({ title: "A", pages: [{ path: "/", title: "Home" }] });
    const same = servedDocument({ pages: [{ title: "Home", path: "/" }], title: "A" });
    const other = servedDocument({ title: "B", pages: [{ path: "/", title: "Home" }] });
    expect(same.digest).toBe(one.digest);
    expect(other.digest).not.toBe(one.digest);
    expect(JSON.parse(one.text).digest).toBe(one.digest);
  });

  it("is held by a conditional request naming its digest", () => {
    expect(holdsCurrent('"abc"', "abc")).toBe(true);
    expect(holdsCurrent('W/"old", "abc"', "abc")).toBe(true);
    expect(holdsCurrent('"old"', "abc")).toBe(false);
    expect(holdsCurrent(undefined, "abc")).toBe(false);
  });
});

describe("the shell", () => {
  const shell = { title: "A <b> & co", prefix: "/admin", bundle: "b1", rendererUrl: "/admin/r.js", importMap: { react: "/admin/</script>.js" } };

  it("writes no lang when none is set, and escapes what it embeds", () => {
    const html = shellHtml(shell);
    expect(html).toContain("<html>");
    expect(html).toContain("<title>A &#60;b&#62; &#38; co</title>");
    expect(html).toContain('<script type="importmap">{"imports":{"react":"/admin/\\u003c/script>.js"}}</script>');
    expect(html).toContain("<style>@layer telo.base, telo.theme, telo.component;</style>");
    // A spinner for as long as the root holds nothing.
    expect(html).toContain("#telo-root:empty::before{");
    expect(shellHtml({ ...shell, lang: "pl" })).toContain('<html lang="pl">');
  });
});
