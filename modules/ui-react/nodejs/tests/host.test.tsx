// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import abi from "../src/contract/abi.json" with { type: "json" };
import { loadFixtureComponents, render, type Page, type Rendered } from "./harness.js";
import { component, formNode, tableNode, todos } from "./spec-nodes.js";

let rendered: Rendered | undefined;
afterEach(() => rendered?.unmount());

const probe = component("HostProbe", { basePath: { value: "/api/todos" } });
const counter = (step: number, fail = false) => component("Counter", { step: { value: step }, fail: { value: fail } });
const pages = (first: Page["children"]): Record<string, Page> => ({
  "/": { title: "Home", children: first },
  "/done": { title: "Done", children: [{ type: "text", text: "The done page" }] },
});
const show = (children: Page["children"], prefix = "") =>
  render({ path: "/", prefix, loadModule: loadFixtureComponents, collections: { "/api/todos": todos, "/api/other": todos }, pages: pages(children) });
const pageRequests = (r: Rendered) => r.requests.filter((request) => request.includes("/_telo/ui/page"));

describe("the host object", () => {
  it("has exactly the baseline fields", async () => {
    rendered = await show([probe]);
    expect(rendered.fixture("keys").textContent).toBe(abi.hostFields.join(","));
  });

  it("moves within a page without fetching, and re-renders whoever reads the location", async () => {
    rendered = await show([probe]);
    expect(rendered.fixture("location").textContent).toBe("/");
    const before = pageRequests(rendered).length;
    await rendered.click(rendered.fixture("query"));
    expect(window.location.search).toBe("?c=2");
    expect(rendered.fixture("location").textContent).toBe("/?c=2");
    expect(pageRequests(rendered).length).toBe(before);
  });

  it("renders the other page on a navigation to it, and the not-found shell for no page", async () => {
    rendered = await show([probe]);
    await rendered.click(rendered.fixture("nowhere"));
    expect(rendered.part("page").getAttribute("data-state")).toBe("empty");
    expect(rendered.part("page-title").textContent).toBe("Not found");
    rendered.unmount();
    rendered = await show([probe]);
    await rendered.click(rendered.fixture("page"));
    expect(window.location.pathname).toBe("/done");
    expect(rendered.part("text").textContent).toBe("The done page");
    expect(rendered.parts("nav-link").map((link) => link.getAttribute("data-current"))).toEqual([null, "page"]);
  });

  it("replaces the current history entry when asked to", async () => {
    rendered = await show([probe]);
    await rendered.click(rendered.fixture("query"));
    const entries = window.history.length;
    await rendered.click(rendered.fixture("replace"));
    expect(window.location.search).toBe("?c=3");
    expect(window.history.length).toBe(entries);
  });

  it("refuses a reference with a scheme", async () => {
    rendered = await show([probe]);
    await rendered.click(rendered.fixture("external"));
    expect(rendered.fixture("refused").textContent).toBe("TypeError");
  });

  it("answers href and location in the application's address space under a mount", async () => {
    rendered = await show([probe], "/admin");
    expect(rendered.fixture("href").textContent).toBe("/admin/done?x=1");
    expect(rendered.fixture("location").textContent).toBe("/");
    expect(rendered.part("nav-link").getAttribute("href")).toBe("/admin/");
  });

  it("follows a link only to a page the application declares, and leaves any other address under the mount to the browser", async () => {
    rendered = await show([{ type: "link", text: "A file", href: "/files/a.pdf" }, { type: "link", text: "Done", href: "/done" }], "/admin");
    const [file, done] = rendered.parts("link");
    expect([file.getAttribute("href"), file.getAttribute("target"), done.getAttribute("target")]).toEqual(["/admin/files/a.pdf", null, null]);
    expect(await rendered.click(file)).toBe(false);
    expect(window.location.pathname).toBe("/admin/");
    expect(rendered.part("page-title").textContent).toBe("Home");
    expect(await rendered.click(done)).toBe(true);
    expect(window.location.pathname).toBe("/admin/done");
    expect(rendered.part("text").textContent).toBe("The done page");
  });

  it("follows a plain click on its own anchors and leaves the rest to the browser", async () => {
    rendered = await show([probe]);
    expect(await rendered.click(rendered.fixture("anchor"), { ctrlKey: true })).toBe(false);
    expect(await rendered.click(rendered.fixture("outside"))).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(await rendered.click(rendered.fixture("anchor"))).toBe(true);
    expect(window.location.pathname).toBe("/done");
    expect(rendered.part("text").textContent).toBe("The done page");
  });

  it("returns the platform response, whose body is read as it arrives", async () => {
    rendered = await show([probe]);
    const bytes = new TextEncoder();
    rendered.answer("/api/todos", () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.encode("first"));
            controller.enqueue(bytes.encode("second"));
            controller.close();
          },
        }),
        { status: 403 },
      ),
    );
    await rendered.click(rendered.fixture("read"));
    expect(rendered.fixture("status").textContent).toBe("403");
    expect(rendered.fixture("chunks").textContent).toBe("first|second");
  });

  it("refetches the tables on a changed collection, and no other", async () => {
    rendered = await show([probe, tableNode(), tableNode({ basePath: "/api/other" })]);
    const lists = (base: string) => rendered!.requests.filter((request) => request.startsWith(`GET ${base}?`)).length;
    const [same, other] = [lists("/api/todos"), lists("/api/other")];
    await rendered.click(rendered.fixture("notify"));
    expect(lists("/api/todos")).toBe(same + 1);
    expect(lists("/api/other")).toBe(other);
  });

  it("tells listeners of a form's write and of a delete, until they unsubscribe", async () => {
    rendered = await show([probe, formNode(), tableNode()]);
    await rendered.enter(rendered.part("input"), "From the form");
    await rendered.click(rendered.part("submit"));
    expect(rendered.fixture("changes").textContent).toBe("1");
    await rendered.click(rendered.parts("row-delete")[0]);
    await rendered.click(rendered.part("surface").querySelector('[data-telo-part="submit"]') as HTMLElement);
    expect(rendered.fixture("changes").textContent).toBe("2");
    await rendered.click(rendered.fixture("stop"));
    await rendered.click(rendered.fixture("notify"));
    expect(rendered.fixture("changes").textContent).toBe("2");
  });

  it("hosts a portal, and a synchronous flush", async () => {
    rendered = await show([probe]);
    expect(rendered.fixture("portal").parentElement).toBe(document.body);
    await rendered.click(rendered.fixture("flush"));
    expect(rendered.fixture("flushed").textContent).toBe("flushed");
  });
});

describe("a hosted component", () => {
  it("keeps its state across a re-render of the page, and takes a changed property without remounting", async () => {
    rendered = await show([counter(2)]);
    const button = rendered.fixture("counter");
    await rendered.click(button);
    expect(button.textContent).toBe("2");
    rendered.setPage("/", { title: "Home", children: [counter(5)] });
    await rendered.hello();
    await rendered.hello();
    expect(rendered.fixture("counter")).toBe(button);
    expect(button.textContent).toBe("2");
    expect(button.getAttribute("data-step")).toBe("5");
  });

  it("is replaced by the error node when it throws, the rest of the page intact", async () => {
    rendered = await show([{ type: "text", text: "Above" }, counter(1, true)]);
    expect(rendered.part("error-code").textContent).toBe("ERR_UI_COMPONENT_FAILED");
    expect(rendered.part("component").getAttribute("data-state")).toBe("error");
    expect(rendered.part("text").textContent).toBe("Above");
  });

  it.each([
    ["ERR_UI_COMPONENT_LOAD_FAILED", async () => Promise.reject(new Error("offline"))],
    ["ERR_UI_COMPONENT_EXPORT_MISSING", async () => ({})],
  ])("shows %s when its module does not give it", async (code, loadModule) => {
    rendered = await render({ path: "/", loadModule, pages: pages([counter(1)]) });
    expect(rendered.part("error-code").textContent).toBe(code);
  });

  it("gets a row-bound property only inside a table cell, and its stylesheet in the component layer", async () => {
    rendered = await show([component("StatusPill", { done: { root: "row", path: ["isDone"] } }), tableNode()]);
    const pills = [...document.querySelectorAll(".fixture-pill")].map((pill) => pill.textContent);
    expect(pills).toEqual(["Open", "Done", "Open"]);
    const styles = [...document.head.querySelectorAll("style[data-telo-component-style]")].map((style) => style.textContent);
    expect(styles).toEqual(['@import url("/_telo/ui/assets/cc/components.css") layer(telo.component);']);
  });
});
