// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, type Rendered } from "./harness.js";

let rendered: Rendered | undefined;
let visibility: DocumentVisibilityState = "visible";
const NOW = new Date("2026-11-06T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const show = (children: unknown[]) => render({ path: "/", pages: { "/": { title: "Times", children: children as never } } });
const time = (value: unknown, relative: boolean) => ({ type: "time", value: { value }, relative });
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const shown = (r: Rendered) => r.parts("time").map((each) => [each.tagName.toLowerCase(), each.textContent, each.getAttribute("datetime"), each.getAttribute("title")]);
const pass = async (r: Rendered, ms: number) => {
  await act(async () => vi.advanceTimersByTime(ms));
  await r.settle();
};

describe("a time node", () => {
  it("draws a date-time relative to now, the exact time as its tooltip and as its machine-readable time", async () => {
    rendered = await show([time(ago(180), true)]);
    const exact = new Intl.DateTimeFormat(["en"], { dateStyle: "medium", timeStyle: "medium" }).format(new Date(ago(180)));
    expect(shown(rendered)).toEqual([["time", "3 hours ago", "2026-11-06T09:00:00.000Z", exact]]);
  });

  it("is drawn again every minute while the document is visible, and on its return to it", async () => {
    rendered = await show([time(ago(5), true)]);
    await pass(rendered, 60_000);
    expect(rendered.part("time").textContent).toBe("6 minutes ago");
    visibility = "hidden";
    await pass(rendered, 120_000);
    expect(rendered.part("time").textContent).toBe("6 minutes ago");
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await rendered.settle();
    expect(rendered.part("time").textContent).toBe("8 minutes ago");
  });

  it("draws a date or a date-time absolute in the viewer's language and zone, and a value that is no date as its text", async () => {
    rendered = await show([time("2026-11-05", false), time("2026-11-05T16:20:00Z", false), time("not yet", true), time(null, true)]);
    const absolute = new Intl.DateTimeFormat(["en"], { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-05T16:20:00Z"));
    expect(shown(rendered)).toEqual([
      ["time", "Nov 5, 2026", "2026-11-05", null],
      ["time", absolute, "2026-11-05T16:20:00.000Z", null],
      ["span", "not yet", null, null],
    ]);
  });
});

describe("a list", () => {
  it("styles each row by its rowStyle and each cell by its column's style, and draws a time column as a time node does", async () => {
    const row = (...path: string[]) => ({ root: "row", path });
    rendered = await show([
      {
        type: "list",
        rowActionsDisplay: "auto",
        rows: { value: [{ op: "added", text: "two files", at: ago(60) }, { op: "context", text: "Split", at: ago(1440) }] },
        rowStyle: { by: row("op"), cases: { added: "success", removed: "danger" } },
        columns: [
          { header: "Line", value: row("text"), labels: [], style: { by: row("op"), cases: { context: "muted" }, default: "strong" } },
          { type: "time", header: "When", value: row("at"), relative: true },
        ],
      },
    ]);
    const rows = rendered.parts("table-row");
    expect(rows.map((each) => [each.getAttribute("data-style"), ...[...each.children].map((cell) => [cell.getAttribute("data-style"), cell.textContent])])).toEqual([
      ["success", ["strong", "two files"], [null, "1 hour ago"]],
      [null, ["muted", "Split"], [null, "yesterday"]],
    ]);
  });
});
