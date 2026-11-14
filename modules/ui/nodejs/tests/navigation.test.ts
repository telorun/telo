import { describe, expect, it } from "vitest";
import type { ResourceContext } from "@telorun/sdk";
import { deliveredNavigation, preparedNavigation } from "../src/navigation.js";

const text = (value: string) => ({ text: value });

describe("a navigation delivered for a request", () => {
  it("leaves out an entry switched off, and a group none of whose entries is delivered, every other keeping its key", () => {
    const evaluated = [
      { type: "page", key: "home", path: "/", text: text("Home") },
      { type: "link", key: "docs", href: "https://telo.run", text: text("Docs"), when: false },
      {
        type: "group",
        key: "admin",
        text: text("Admin"),
        items: [
          { type: "page", key: "admin/users", path: "/users", text: text("Users"), when: false },
          { type: "group", key: "admin/nested", text: text("Nested"), items: [{ type: "page", key: "admin/nested/x", path: "/x", text: text("X"), when: false }] },
        ],
      },
      { type: "group", key: "reports", text: text("Reports"), items: [{ type: "page", key: "reports/r", path: "/r", text: text("R"), when: true }] },
    ];
    expect(deliveredNavigation(evaluated)).toEqual([
      { type: "page", key: "home", path: "/", text: text("Home") },
      { type: "group", key: "reports", text: text("Reports"), items: [{ type: "page", key: "reports/r", path: "/r", text: text("R") }] },
    ]);
  });

  it("names each entry by the slug of its source text, under its group's key", async () => {
    const link = (label: string) => ({ type: "link" as const, href: "/x", text: text(label) as never });
    const prepared = await preparedNavigation(
      { items: [{ type: "group", text: text("Admin") as never, items: [link("Users"), link("Users")] }, link("Admin")] },
      {} as ResourceContext,
      "the app",
    );
    const keys = (entries: { key: string; items?: unknown[] }[]): unknown[] =>
      entries.map((entry) => (entry.items === undefined ? entry.key : [entry.key, keys(entry.items as never)]));
    expect(keys(deliveredNavigation(prepared.items))).toEqual([["admin", ["admin/users", "admin/users~2"]], "admin~2"]);
  });

  /** A context reading the pages it declares by name. */
  const declaring = (pages: Record<string, { path: string; title?: unknown }>) =>
    ({ resolveDeclaredManifest: (name: string) => pages[name] }) as unknown as ResourceContext;
  const named = (name: string) => ({ __ref: true, kind: "Ui.Page", name });

  it("reads a page entry off the page's declaration: its path, and its title as written unless the entry says otherwise", async () => {
    const ctx = declaring({ home: { path: "/", title: "Home" }, chat: { path: "/chat", title: { text: "Chat", context: "talk" } } });
    const prepared = await preparedNavigation(
      { items: [{ type: "page", page: named("home") }, { type: "page", page: named("chat") }, { type: "page", page: named("home"), text: text("Start") as never }] },
      ctx,
      "the app",
    );
    expect(deliveredNavigation(prepared.items)).toEqual([
      { type: "page", key: "home", path: "/", text: { text: "Home", context: null, lang: "und", computed: false } },
      { type: "page", key: "chat", path: "/chat", text: { text: "Chat", context: "talk", lang: "und", computed: false } },
      { type: "page", key: "start", path: "/", text: text("Start") },
    ]);
  });

  it("refuses an entry naming a page with no title and no text of its own", async () => {
    const ctx = declaring({ chat: { path: "/chat" } });
    await expect(preparedNavigation({ items: [{ type: "page", page: named("chat") }] }, ctx, "the app")).rejects.toMatchObject({
      code: "ERR_UI_NAVIGATION_PAGE_UNTITLED",
    });
  });

  it("refuses an entry naming a page with a variable in its path", async () => {
    const ctx = declaring({ plan: { path: "/plans/{id}", title: "Plan" } });
    await expect(preparedNavigation({ items: [{ type: "page", page: named("plan") }] }, ctx, "the app")).rejects.toMatchObject({
      code: "ERR_UI_NAVIGATION_PAGE_HAS_PARAMETERS",
    });
  });
});
