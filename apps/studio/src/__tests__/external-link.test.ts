import { afterEach, describe, expect, it } from "vitest";

import { externalAnchorFor, isExternalHref } from "../external-link";

/**
 * A Tauri webview has no handler for external navigation, so an anchor to a
 * running app's endpoint is inert. These pin the rules the delegated handler
 * uses to decide which clicks leave the app — every "no" here is a real click
 * somebody makes, and getting one wrong either breaks in-app navigation or
 * hands another application a URL it cannot open.
 */

const PAGE = "http://localhost:5173";

describe("which addresses leave the app", () => {
  it("routes a different origin out — which is what every endpoint link is", () => {
    // The app's own port, the runner, the inspection UI: all a different port,
    // and so a different origin, from the page the editor is served on.
    expect(isExternalHref("http://localhost:3000", PAGE)).toBe(true);
    expect(isExternalHref("https://telo.sh/docs", PAGE)).toBe(true);
    expect(isExternalHref("http://runner.test:8080/app", PAGE)).toBe(true);
  });

  it("leaves the editor's own origin alone", () => {
    // In dev the editor is itself served over http, so a rule keyed on the
    // scheme alone would hand the dev server's own URLs to a browser.
    expect(isExternalHref("http://localhost:5173/index.html", PAGE)).toBe(false);
    expect(isExternalHref("/workspace/telo.yaml", PAGE)).toBe(false);
    expect(isExternalHref("#section", PAGE)).toBe(false);
  });

  it("routes the scheme-only addresses, which have no origin to compare", () => {
    expect(isExternalHref("mailto:someone@example.com", PAGE)).toBe(true);
    expect(isExternalHref("tel:+15550100", PAGE)).toBe(true);
  });

  it("refuses an address that names memory in this webview", () => {
    // There is nothing for another application to open, and neither is in the
    // scope the Tauri capability grants.
    expect(isExternalHref("blob:http://localhost:5173/abc-123", PAGE)).toBe(false);
    expect(isExternalHref("data:text/plain,hello", PAGE)).toBe(false);
    expect(isExternalHref("not a url", PAGE)).toBe(false);
  });
});

describe("which clicks the handler claims", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function anchor(attrs: Record<string, string>): HTMLAnchorElement {
    const el = document.createElement("a");
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    el.textContent = "link";
    document.body.append(el);
    return el;
  }

  function click(target: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  it("claims a plain left click on an external anchor", () => {
    const el = anchor({ href: "http://runner.test:8080/", target: "_blank" });
    expect(externalAnchorFor(click(el))).toBe(el);
  });

  it("claims a click on something nested inside the anchor", () => {
    // Endpoint chips wrap their label in a span, so the click's target is never
    // the anchor itself.
    const el = anchor({ href: "http://runner.test:8080/" });
    const inner = document.createElement("span");
    el.append(inner);
    expect(externalAnchorFor(click(inner))).toBe(el);
  });

  it("leaves a save link to the platform", () => {
    // debug-ui's payload download writes a file; it is not a place to visit.
    const el = anchor({ href: "blob:http://localhost:5173/abc", download: "payload.json" });
    expect(externalAnchorFor(click(el))).toBeNull();
  });

  it("leaves the user's own modifier and middle clicks alone", () => {
    const el = anchor({ href: "http://runner.test:8080/" });
    expect(externalAnchorFor(click(el, { metaKey: true }))).toBeNull();
    expect(externalAnchorFor(click(el, { ctrlKey: true }))).toBeNull();
    expect(externalAnchorFor(click(el, { shiftKey: true }))).toBeNull();
    expect(externalAnchorFor(click(el, { button: 1 }))).toBeNull();
  });

  it("yields to a component that already handled the click", () => {
    const el = anchor({ href: "http://runner.test:8080/" });
    const event = click(el);
    event.preventDefault();
    expect(externalAnchorFor(event)).toBeNull();
  });

  it("leaves an anchor pointing back at the editor to in-app navigation", () => {
    const el = anchor({ href: `${window.location.origin}/index.html` });
    expect(externalAnchorFor(click(el))).toBeNull();
  });

  it("ignores a click on no anchor at all", () => {
    const div = document.createElement("div");
    document.body.append(div);
    expect(externalAnchorFor(click(div))).toBeNull();
  });
});
