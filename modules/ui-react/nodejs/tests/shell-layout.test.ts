import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The DOM the tests run in applies no layered stylesheet, so the shell's layout
// is pinned as the base layer declares it; the alignment it yields is not
// measured by any automated test.
const base = readFileSync(new URL("../src/browser/base.css", import.meta.url), "utf8");

/** The declarations of the rule written with exactly this selector. */
function declared(selector: string): Record<string, string> {
  const rules = [...base.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, written]) =>
    written
      .replace(/\/\*[^]*?\*\//g, "")
      .split(",")
      .map((part) => part.trim())
      .includes(selector),
  );
  expect(rules, selector).toHaveLength(1);
  return Object.fromEntries(
    rules[0][2]
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => [declaration.slice(0, declaration.indexOf(":")).trim(), declaration.slice(declaration.indexOf(":") + 1).trim()]),
  );
}

const app = '[data-telo-part="app"]';
const header = '[data-telo-part="header"]';
const footer = '[data-telo-part="footer"]';
const headerContent = '[data-telo-part="header-content"]';
const footerContent = '[data-telo-part="footer-content"]';
const region = `${app}[data-side] > [data-telo-region="aside"] > div > div > [data-telo-part="aside"]`;

describe("the shell's layout", () => {
  it("insets a contained header's and footer's content as a contained page is inset, a full one by the page inset alone", () => {
    expect(declared('[data-telo-part="main"]')["padding-inline"]).toBe("var(--telo-space-page)");
    expect(declared('[data-telo-part="page"][data-width="contained"]')).toEqual({ "max-width": "var(--telo-width-page)", "margin-inline": "auto" });
    for (const [region, content] of [
      [header, headerContent],
      [footer, footerContent],
    ]) {
      expect(declared(`${region}[data-width="contained"] > ${content}`)["padding-inline"]).toBe("max(var(--telo-space-page), calc((100% - var(--telo-width-page)) / 2))");
      expect(declared(`${region}[data-width="full"] > ${content}`)["padding-inline"]).toBe("var(--telo-space-page)");
    }
  });

  it("insets the header's and footer's content against the application whatever the aside does", () => {
    // Folded, unfolded or compact, the aside changes no rule that reaches a
    // region's content: the inset is the same expression over the application's width.
    const selectors = [...base.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(([, written]) => written.replace(/\/\*[^]*?\*\//g, "").split(",").map((part) => part.trim()));
    const reachingContent = selectors.filter((selector) => /(header|footer)-content/.test(selector));
    expect(reachingContent.length).toBeGreaterThan(0);
    for (const selector of reachingContent) expect(selector).not.toMatch(/data-side|data-state|data-compact|aside/);
    expect(declared(`${app}[data-side] > ${header}`)["grid-column"]).toBeUndefined();
    expect(declared(`${app} > ${header}`)["grid-column"]).toBe("1 / -1");
  });

  it("places an aside beside the page between the header and the footer, which span every column", () => {
    expect(declared(`${app} > ${header}`)["grid-column"]).toBe("1 / -1");
    expect(declared(`${app}[data-side] > ${header}`)["grid-row"]).toBe("1");
    expect(declared(`${app}[data-side] > [data-telo-part="main"]`)).toEqual({ "grid-row": "2", "grid-column": "main" });
    expect(declared(`${app}[data-side] > ${footer}`)["grid-row"]).toBe("3");
    expect(declared(region)["grid-column"]).toBe("side");
    for (const columns of [declared(`${app}[data-side]`)["grid-template-columns"], declared(`${app}[data-side="end"]`)["grid-template-columns"]]) {
      expect(columns).toMatch(/\[[^\]]*\bmain-start\b[^\]]*\] minmax\(0, 1fr\) \[[^\]]*\bmain-end\b[^\]]*\]/);
    }
    expect([declared(header).display, declared(footer).display]).toEqual(["block", "block"]);
  });
});
