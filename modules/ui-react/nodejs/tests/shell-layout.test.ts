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
const withSidebar = `${app}:has(> [data-telo-part="sidebar"])`;
const header = '[data-telo-part="header"]';
const content = '[data-telo-part="header-content"]';

describe("the shell's layout", () => {
  it("insets a contained header's content as a contained page is inset, a full one by the page inset alone", () => {
    expect(declared('[data-telo-part="main"]')["padding-inline"]).toBe("var(--telo-space-page)");
    expect(declared('[data-telo-part="page"][data-width="contained"]')).toEqual({ "max-width": "var(--telo-width-page)", "margin-inline": "auto" });
    expect(declared(`${header}[data-width="contained"] > ${content}`)["padding-inline"]).toBe(
      "max(var(--telo-space-page), calc((100% - var(--telo-width-page)) / 2))",
    );
    expect(declared(`${header}[data-width="full"] > ${content}`)["padding-inline"]).toBe("var(--telo-space-page)");
  });

  it("beside a sidebar, makes the header a subgrid of every column, a contained header's content over the page's column", () => {
    expect(declared(`${app} > ${header}`)["grid-column"]).toBe("1 / -1");
    expect(declared(`${withSidebar} > ${header}`)).toEqual({ display: "grid", "grid-template-columns": "subgrid" });
    expect(declared(`${withSidebar} > ${header} > ${content}`)["grid-column"]).toBe("1 / -1");
    expect(declared(`${withSidebar} > ${header}[data-width="contained"] > ${content}`)["grid-column"]).toBe("main");
    for (const columns of [declared(withSidebar)["grid-template-columns"], declared(`${app}:has(> [data-telo-part="sidebar"][data-side="end"])`)["grid-template-columns"]]) {
      expect(columns).toMatch(/\[[^\]]*\bmain-start\b[^\]]*\] minmax\(0, 1fr\) \[[^\]]*\bmain-end\b[^\]]*\]/);
    }
    expect(declared(header).display).toBe("block");
  });
});
