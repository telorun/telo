import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createCollection } from "../../tests/__fixtures__/collection-api/collection.mjs";
import { App } from "../src/browser/app.js";
import type { SpecNode } from "../src/browser/nodes.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// What the primitives ask of a browser that jsdom does not have.
if (typeof Element !== "undefined") {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
}

export const BUNDLE = "bundle-1";

/** The event stream, as the test drives it. */
class FakeEventSource extends EventTarget {
  static latest?: FakeEventSource;
  constructor(readonly url: string) {
    super();
    FakeEventSource.latest = this;
  }
  close() {}
}
(globalThis as any).EventSource = FakeEventSource;

export interface Page {
  title: string;
  children: SpecNode[];
}

type Responder = () => Response | Promise<Response>;

export interface Rendered {
  container: HTMLElement;
  /** Finish loading the stylesheets a render was asked to hold. */
  loadStylesheets(): Promise<void>;
  /** Every request made, as `METHOD url`. */
  requests: string[];
  /** Every request that carried a body, with the body as it was sent. */
  sent: { request: string; contentType: string | null; body: unknown }[];
  /** Replace a page's children, as a server would between two requests. */
  setPage(path: string, page: Page): void;
  /** Answer the next requests to a URL prefix with this response. */
  answer(prefix: string, respond: Responder): void;
  /** Make the server report another renderer than the one running. */
  setBundle(bundle: string): void;
  part(name: string): HTMLElement;
  parts(name: string): HTMLElement[];
  fixture(name: string): HTMLElement;
  /** Click, answering whether the application took the click for itself. */
  click(element: Element, init?: MouseEventInit): Promise<boolean>;
  /** Deliver the server's `hello`, as on a connection or a reconnection. */
  hello(bundle?: string): Promise<void>;
  enter(element: Element, value: string): Promise<void>;
  /** Open a choice control's list from the keyboard; jsdom has no pointer events. */
  open(trigger: Element): Promise<void>;
  /** Pick the entry labelled so from a choice control's list, opening it first. */
  choose(trigger: Element, label: string): Promise<void>;
  /** The entries a choice control lists, in order. */
  choices(trigger: Element): Promise<string[]>;
  /** Press Escape where the focus is. */
  escape(): Promise<void>;
  /** Press the pointer down on an element, as a click outside a surface begins. */
  pointerDown(element: Element): Promise<void>;
  /** Step through the browser's history, as its back and forward buttons do. */
  traverse(delta: number): Promise<void>;
  /** The media queries the application asked the viewport about. */
  mediaQueries: string[];
  /** Take the viewport across the application's breakpoint, or back. */
  setNarrow(narrow: boolean): Promise<void>;
  /** Move the keyboard focus to an element. */
  focus(element: HTMLElement): Promise<void>;
  /** Commit what was typed into a field: by Enter, or by leaving it. */
  commit(element: Element, how: "enter" | "blur"): Promise<void>;
  settle(): Promise<void>;
  reloads: number;
  unmount(): void;
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A browser loads a stylesheet it is given and says so; this document does not.
let holdStylesheets = false;
const heldStylesheets: HTMLLinkElement[] = [];
new MutationObserver((records) => {
  for (const record of records) {
    for (const added of record.addedNodes) {
      if (!(added instanceof HTMLLinkElement)) continue;
      if (holdStylesheets) heldStylesheets.push(added);
      else queueMicrotask(() => added.dispatchEvent(new Event("load")));
    }
  }
}).observe(document.head, { childList: true });

/** Render the application against pages and collections held in the test. */
export async function render(options: {
  path: string;
  prefix?: string;
  pages: Record<string, Page>;
  collections?: Record<string, Record<string, unknown>[]>;
  required?: string[];
  loadModule?: (url: string) => Promise<Record<string, unknown>>;
  /** Responses fixed before the first request, by URL prefix. */
  answers?: Record<string, Responder>;
  /** Whether the viewport answers that it is below the application's breakpoint. */
  narrow?: boolean;
  /** Leave the application's stylesheets loading until `loadStylesheets`. */
  holdStylesheets?: boolean;
}): Promise<Rendered> {
  const prefix = options.prefix ?? "";
  const pages = { ...options.pages };
  const versions: Record<string, number> = {};
  const collections = Object.fromEntries(
    Object.entries(options.collections ?? {}).map(([basePath, rows]) => [basePath, createCollection(rows, options.required ?? [])]),
  );
  const answers: [string, Responder][] = Object.entries(options.answers ?? {});
  const requests: string[] = [];
  const sent: Rendered["sent"] = [];
  let bundle = BUNDLE;
  let reloads = 0;

  holdStylesheets = options.holdStylesheets === true;
  heldStylesheets.length = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input), window.location.href);
    requests.push(`${method} ${url.pathname}${url.search}`);
    if (init?.body) {
      sent.push({ request: requests.at(-1) as string, contentType: new Headers(init.headers).get("content-type"), body: JSON.parse(String(init.body)) });
    }
    const forced = answers.find(([start]) => url.pathname.startsWith(start));
    if (forced) return forced[1]();
    if (url.pathname === `${prefix}/_telo/ui/app`) {
      return json({
        specVersion: 1,
        bundle,
        digest: "app-1",
        title: "Test App",
        pages: Object.entries(pages).map(([path, page]) => ({ path, title: page.title })),
        stylesheets: [`${prefix}/_telo/ui/assets/aa/base.css`],
        compactBelow: "40rem",
      });
    }
    if (url.pathname === `${prefix}/_telo/ui/page`) {
      const path = url.searchParams.get("path") as string;
      const digest = `${path}#${versions[path] ?? 0}`;
      if (new Headers(init?.headers).get("if-none-match") === `"${digest}"`) return new Response(null, { status: 304 });
      return json({ specVersion: 1, bundle, digest, path, title: pages[path].title, children: pages[path].children });
    }
    const base = Object.keys(collections).find((candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`));
    if (base) {
      const answer = collections[base].handle({
        method,
        path: url.pathname.slice(base.length),
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json(answer.body, answer.status);
    }
    return json({ error: "NotFound", message: "nothing here", status: 404 }, 404);
  }) as typeof fetch;

  const mediaQueries: string[] = [];
  let narrow = options.narrow === true;
  const viewportWatchers = new Set<() => void>();
  // jsdom has no viewport to ask.
  window.matchMedia = ((query: string) => {
    mediaQueries.push(query);
    return {
      get matches() {
        return narrow;
      },
      media: query,
      addEventListener: (type: string, watcher: () => void) => viewportWatchers.add(watcher),
      removeEventListener: (type: string, watcher: () => void) => viewportWatchers.delete(watcher),
    };
  }) as unknown as typeof window.matchMedia;

  window.history.replaceState(null, "", prefix + options.path);
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;
  const settle = async () => {
    for (let turn = 0; turn < 6; turn++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  };
  await act(async () => {
    root = createRoot(container);
    root.render(<App prefix={prefix} bundle={BUNDLE} reload={() => reloads++} loadModule={options.loadModule} />);
  });
  await settle();

  const parts = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-telo-part="${name}"]`)];
  const open = async (trigger: Element) => {
    if (trigger.getAttribute("aria-expanded") === "true") return;
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await settle();
    if (trigger.getAttribute("aria-expanded") !== "true") throw new Error("the choice control did not open");
  };
  const escape = async () => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  };
  return {
    async loadStylesheets() {
      await act(async () => {
        for (const link of heldStylesheets.splice(0)) link.dispatchEvent(new Event("load"));
      });
    },
    open,
    escape,
    mediaQueries,
    async setNarrow(next) {
      narrow = next;
      await act(async () => {
        for (const watcher of [...viewportWatchers]) watcher();
      });
      await settle();
    },
    async pointerDown(element) {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      });
      await settle();
    },
    async traverse(delta) {
      await act(async () => window.history.go(delta));
      await settle();
    },
    async choose(trigger, label) {
      await open(trigger);
      const item = parts("select-item").find((candidate) => candidate.textContent === label);
      if (!item) throw new Error(`the list has no entry '${label}'`);
      await act(async () => {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await settle();
    },
    async choices(trigger) {
      await open(trigger);
      const labels = parts("select-item").map((item) => item.textContent ?? "");
      await escape();
      return labels;
    },
    async focus(element) {
      await act(async () => element.focus());
      await settle();
    },
    container,
    requests,
    sent,
    setPage(path, page) {
      pages[path] = page;
      versions[path] = (versions[path] ?? 0) + 1;
    },
    answer(start, respond) {
      answers.unshift([start, respond]);
    },
    setBundle(next) {
      bundle = next;
    },
    parts,
    part(name) {
      const found = parts(name)[0];
      if (!found) throw new Error(`no '${name}' part is rendered`);
      return found;
    },
    fixture(name) {
      const found = document.querySelector<HTMLElement>(`[data-fixture="${name}"]`);
      if (!found) throw new Error(`no '${name}' fixture element is rendered`);
      return found;
    },
    async click(element, init) {
      let taken = false;
      // jsdom cannot navigate, so a click the application left alone ends here.
      const watch = (event: Event) => {
        taken = event.defaultPrevented;
        if ((event.target as Element).closest("a")) event.preventDefault();
      };
      document.addEventListener("click", watch, { once: true });
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
      });
      document.removeEventListener("click", watch);
      await settle();
      return taken;
    },
    async hello(announced = BUNDLE) {
      await act(async () => {
        FakeEventSource.latest?.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ bundle: announced }) }));
      });
      await settle();
    },
    async enter(element, value) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    async commit(element, how) {
      await act(async () => {
        element.dispatchEvent(
          how === "enter"
            ? new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
            : new FocusEvent("focusout", { bubbles: true }),
        );
      });
      await settle();
    },
    settle,
    get reloads() {
      return reloads;
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

const fixtureComponents = (await import("../../tests/__fixtures__/components/nodejs/src/components.js")) as Record<string, unknown>;

/** The fixture component library, loaded from its sources. */
export const loadFixtureComponents = async () => fixtureComponents;
