import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlanBody } from "@/plan/PlanBody";

const render = (body: string, items: string[]) =>
  renderToStaticMarkup(
    <PlanBody body={body} items={items} itemControl={(id) => <button data-control={id} />} />,
  );

describe("PlanBody", () => {
  it("renders raw HTML as text", () => {
    const html = render("# Plan\n\n<script>alert(1)</script>\n\nText <b>bold</b>", []);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("places a comment control on exactly the lines whose ID the server stored", () => {
    const body = "## S1 Build\n\n- **C1**: check\n- C2 other\n- plain item\n\n## Notes";
    const controls = [...render(body, ["S1", "C1"]).matchAll(/data-control="([^"]+)"/g)].map((m) => m[1]);
    expect(controls).toEqual(["S1", "C1"]);
  });
});
