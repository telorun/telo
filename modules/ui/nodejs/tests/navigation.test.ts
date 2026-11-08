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
      [],
      {} as ResourceContext,
      "the app",
      async () => "",
    );
    const keys = (entries: { key: string; items?: unknown[] }[]): unknown[] =>
      entries.map((entry) => (entry.items === undefined ? entry.key : [entry.key, keys(entry.items as never)]));
    expect(keys(deliveredNavigation(prepared.items))).toEqual([["admin", ["admin/users", "admin/users~2"]], "admin~2"]);
  });

  it("leaves a page with no title out of an omitted navigation, and refuses an entry naming one without text of its own", async () => {
    const page = (path: string, title?: string) => ({ snapshot: () => ({ path, ...(title === undefined ? {} : { title: text(title) }), query: {} }) }) as never;
    const ctx = { resolveRef: (reference: unknown) => reference } as unknown as ResourceContext;
    const bare = page("/chat");
    const prepared = await preparedNavigation(undefined, [page("/", "Home"), bare], ctx, "the app", async () => "");
    expect(deliveredNavigation(prepared.items).map((entry) => (entry as { path: string }).path)).toEqual(["/"]);
    await expect(preparedNavigation({ items: [{ type: "page", page: bare }] } as never, [bare], ctx, "the app", async () => "")).rejects.toMatchObject({
      code: "ERR_UI_NAVIGATION_PAGE_UNTITLED",
    });
    const labelled = await preparedNavigation({ items: [{ type: "page", page: bare, text: text("Chat") }] } as never, [bare], ctx, "the app", async () => "");
    expect(deliveredNavigation(labelled.items)).toEqual([{ type: "page", key: "chat", path: "/chat", text: text("Chat") }]);
  });
});
