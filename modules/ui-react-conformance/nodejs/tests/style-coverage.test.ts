import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { StyleCoverage, type StyleContract, type UnstyledPart } from "../src/style-coverage.js";
import { readStylesheet } from "../src/stylesheet-rules.js";

const contract: StyleContract = {
  parts: ["page", "table", "row", "filters-bar"],
  reserved: [{ part: "filters-bar", properties: ["display", "bottom"], because: "a closed bar is hidden" }],
};

/** A page holding every part of the contract, the table's row inside it. */
const PAGE = `
  <main data-telo-part="page">
    <div data-telo-part="table"><div data-telo-part="row"></div></div>
    <div data-telo-part="filters-bar"></div>
  </main>`;

/** The problems a theme of one stylesheet has over that page. */
function problemsOf(css: string, unstyled: UnstyledPart[] = []) {
  const read = readStylesheet(css);
  if (!read.ok) throw new Error(read.message);
  const window = new Window();
  window.document.body.innerHTML = PAGE;
  const coverage = new StyleCoverage([{ path: "/theme.css", reading: read.reading }]);
  coverage.record(window.document as unknown as Document);
  return coverage.problems(contract, unstyled);
}

const unstyledParts = (css: string) =>
  problemsOf(css)
    .filter((problem) => problem.check === "part-unstyled")
    .map((problem) => problem.subject);

describe("the style checks", () => {
  it("report every part no rule tells apart from the others", () => {
    expect(problemsOf(`[data-telo-part="page"] { color: red }`)).toEqual(
      ["table", "row", "filters-bar"].map((part) => ({
        check: "part-unstyled",
        subject: part,
        message: `No rule of the theme styles the '${part}' part apart from the others. Style it, or list it in 'unstyled' with the reason.`,
      })),
    );
  });

  it("count no rule on every element, nor on the attribute every part carries", () => {
    expect(unstyledParts(`* { color: red } [data-telo-part] { margin: 0 }`)).toEqual(["page", "table", "row", "filters-bar"]);
  });

  it("match a rule as it applies in some state, pseudo-elements and user actions aside", () => {
    expect(unstyledParts(`[data-telo-part=page]:hover { color: red } [data-telo-part=table]::before { content: "" }`)).toEqual(["row", "filters-bar"]);
  });

  it("match a nested rule as its full selector", () => {
    expect(unstyledParts(`[data-telo-part=table] { color: red; [data-telo-part=row] { color: blue } }`)).toEqual(["page", "filters-bar"]);
    expect(unstyledParts(`[data-telo-part=page] { color: red; > [data-telo-part=table] { color: blue } }`)).toEqual(["row", "filters-bar"]);
    expect(unstyledParts(`[data-telo-part=filters-bar] { & [data-telo-part=row] { color: blue } }`)).toEqual(["page", "table", "row", "filters-bar"]);
  });

  it("match :is() and :has() as the window does", () => {
    expect(unstyledParts(`:is([data-telo-part=page], [data-telo-part=row]) { color: red }`)).toEqual(["table", "filters-bar"]);
    expect(unstyledParts(`[data-telo-part]:has(> [data-telo-part=row]) { color: red }`)).toEqual(["page", "row", "filters-bar"]);
  });

  it("read rules under @media, @supports, @layer and @container", () => {
    expect(
      unstyledParts(`
        @media (min-width: 1px) { [data-telo-part=page] { color: red } }
        @supports (display: grid) { [data-telo-part=table] { color: red } }
        @layer look { [data-telo-part=row] { color: red } }
        @container (min-width: 1px) { [data-telo-part=filters-bar] { color: red } }`),
    ).toEqual([]);
  });

  it("report an unstyled entry for a part the theme styles, or for no part at all", () => {
    expect(
      problemsOf(`[data-telo-part=page], [data-telo-part=table], [data-telo-part=row] { color: red }`, [
        { part: "filters-bar", reason: "the renderer's layout is enough" },
        { part: "row", reason: "plain" },
        { part: "rows", reason: "plain" },
      ]),
    ).toEqual([
      { check: "unstyled-stale", subject: "row", message: `'unstyled' lists 'row', but the theme styles it ('[data-telo-part=page], [data-telo-part=table], [data-telo-part=row]' in /theme.css). Remove it from 'unstyled'.` },
      { check: "unstyled-stale", subject: "rows", message: "'unstyled' lists 'rows', which is no part the renderer draws. Remove it." },
    ]);
  });

  it("report a reserved property any matching rule sets, through a shorthand too", () => {
    const reserved = problemsOf(`* { display: block } [data-telo-part=filters-bar] { inset: 0 } [data-telo-part=page], [data-telo-part=table], [data-telo-part=row], [data-telo-part=filters-bar] { color: red }`).filter(
      (problem) => problem.check === "property-reserved",
    );
    expect(reserved.map((problem) => problem.subject)).toEqual(["filters-bar: display", "filters-bar: bottom"]);
    expect(reserved[1].message).toBe(
      "'[data-telo-part=filters-bar]' in /theme.css sets 'bottom' on the 'filters-bar' part, which the renderer reserves: a closed bar is hidden.",
    );
  });

  it("refuse a stylesheet css-tree cannot parse", () => {
    expect(readStylesheet(`[data-telo-part=page] { color: red; }\n}} .x {`)).toEqual({ ok: false, message: "Selector is expected at line 2, column 1" });
  });
});
