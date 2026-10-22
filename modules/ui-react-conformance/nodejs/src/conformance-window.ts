import { Window as HappyWindow } from "happy-dom";
import { Console } from "node:console";
import { Writable } from "node:stream";

/** The page a check draws in, as the DOM declares a window, and how it is closed. */
export interface ConformanceWindow {
  window: Window & typeof globalThis;
  close(): Promise<void>;
}

/**
 * Names the host defines that a page must see as the window's: the DOM's own
 * events and the classes its elements are built from, and the network a scene
 * answers — every other name the host has stays the host's.
 */
const WINDOW_OWNED = new Set([
  "Event",
  "CustomEvent",
  "MessageEvent",
  "CloseEvent",
  "EventTarget",
  "DOMException",
  "Navigator",
  "navigator",
  "Blob",
  "File",
  "FormData",
  "AbortController",
  "AbortSignal",
  "Headers",
  "Request",
  "Response",
  "fetch",
]);

/** Names that are the realm's own and never the window's. */
const REALM = new Set(["constructor", "window", "self", "top", "parent", "globalThis", "global"]);

function windowNames(window: object): Set<string> {
  const names = new Set<string>();
  for (let at: object | null = window; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
    for (const name of Object.getOwnPropertyNames(at)) names.add(name);
  }
  return names;
}

/**
 * A console handing each line written to it to `line`, blank lines left out:
 * what the page writes is the check's to report, never the host's output.
 */
export function windowConsole(line: (text: string) => void): Console {
  const sink = new Writable({
    write(chunk, encoding, done) {
      for (const text of String(chunk).split("\n")) if (text.trim() !== "") line(text);
      done();
    },
  });
  return new Console({ stdout: sink, stderr: sink });
}

/**
 * Open the window a check runs in, `prepare` it, and make it the page this
 * thread is: every name of the window the host lacks — and the few the window
 * must own — reads through to the window, so React, the renderer and a control
 * see one document. A worker owns its globals; this is only ever done in the
 * check's own thread.
 */
export function openWindow(prepare: (window: Window) => void, console: Console): ConformanceWindow {
  const happy = new HappyWindow({ url: "http://localhost/", console, settings: { disableErrorCapturing: true } });
  const window = happy as unknown as Window & typeof globalThis;
  prepare(window);
  const scope = globalThis as unknown as Record<string, unknown>;
  const source = window as unknown as Record<string, unknown>;
  for (const name of windowNames(window)) {
    if (REALM.has(name) || (name in scope && !WINDOW_OWNED.has(name))) continue;
    const value = source[name];
    const bound = typeof value === "function" && !/^[A-Z]/.test(name) ? (value as (...args: unknown[]) => unknown).bind(window) : undefined;
    Object.defineProperty(scope, name, {
      configurable: true,
      get: () => (bound !== undefined && source[name] === value ? bound : source[name]),
      set: (next) => {
        source[name] = next;
      },
    });
  }
  Object.defineProperty(scope, "window", { configurable: true, value: window });
  return { window, close: () => happy.happyDOM.close() };
}
