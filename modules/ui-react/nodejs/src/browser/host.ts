import { createContext, useContext, useSyncExternalStore } from "react";
import type { Host, HostLocation } from "../contract/ui-react.js";
import { openValue, withFiltersOf, withOpen } from "./open-address.js";

export type { Host, HostLocation };

/** An app-relative reference, resolved. */
interface Target {
  path: string;
  search: string;
  hash: string;
}

/** A form holding unsaved input, as the store asks about it. */
export interface UnsavedGuard {
  /** Whether the form is still shown at a location. */
  shows(target: HostLocation): boolean;
  /** Drop the input: the user chose to leave. */
  discard(): void;
}

const POSITION = "teloPosition";

/** The position the application stamped on a history entry, if it did. */
function positionOf(state: unknown): number | undefined {
  const position = (state as Record<string, unknown> | null)?.[POSITION];
  return typeof position === "number" ? position : undefined;
}

/**
 * The state behind `useHost`: where the page is, who listens for a collection
 * changing, and which forms hold unsaved input. One per rendered application.
 *
 * Every move goes through one check: a move that would close a form holding
 * unsaved input waits for the user's answer, and happens only if they leave.
 */
export class HostStore {
  private host: Host;
  private readonly watchers = new Set<() => void>();
  private readonly changes = new Map<string, Set<() => void>>();
  private readonly guards = new Set<UnsavedGuard>();
  private question?: { guards: UnsavedGuard[]; perform: () => void };
  /** The index of the current history entry among those this application wrote. */
  private position: number;
  /** The entries an opening added during this visit, each by the surface it
   *  opened and the page it was on. One lasts while its entry still shows that
   *  surface on that page. */
  private readonly openings = new Map<number, { name: string; path: string }>();
  /** Where a close that steps back is going: the address it leaves, less the surface. */
  private returning?: Target;
  /** A traversal being undone so the question can be asked from the form's entry. */
  private undoing?: { delta: number; guards: UnsavedGuard[] };

  /** `prefix` is the mount path with no trailing slash; empty at the root. */
  constructor(readonly prefix: string) {
    this.host = this.hostAt(this.locationOf(window.location));
    const stamped = positionOf(window.history.state);
    this.position = stamped ?? 0;
    if (stamped === undefined) window.history.replaceState({ ...window.history.state, [POSITION]: 0 }, "");
  }

  readonly subscribe = (watcher: () => void): (() => void) => {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  };

  readonly snapshot = (): Host => this.host;

  /** Whether the user is being asked about unsaved input. */
  readonly asking = (): boolean => this.question !== undefined;

  /**
   * Take the browser's own address as the location — after back or forward.
   * A traversal that would close a form holding unsaved input is first undone,
   * so the address, the history and the form are as they were while the user
   * is asked; leaving replays it. What the page's filter bars hold travels
   * with the page: an entry of the same page is brought up to it.
   */
  readonly syncFromAddress = (): void => {
    const location = this.locationOf(window.location);
    const position = positionOf(window.history.state);
    if (this.returning) {
      // A close arriving at the entry before the opening: that entry becomes
      // the address the close left, less the surface, and nothing in between
      // is shown or asked about.
      const target = this.returning;
      this.returning = undefined;
      this.position = position ?? this.position - 1;
      this.write(target, true);
      return;
    }
    if (this.undoing) {
      const { delta, guards } = this.undoing;
      this.undoing = undefined;
      this.ask(guards, () => window.history.go(delta));
      return;
    }
    const closing = this.closedBy(location);
    if (closing.length > 0 && position !== undefined && position !== this.position) {
      this.undoing = { delta: position - this.position, guards: closing };
      window.history.go(this.position - position);
      return;
    }
    if (position === undefined) return this.moveTo(location);
    this.position = position;
    const carried = location.path === this.host.location.path ? withFiltersOf(location.search, this.host.location.search) : undefined;
    if (carried === undefined) this.moveTo(location);
    else this.write({ ...location, search: carried }, true);
  };

  /** Hold a form's unsaved input until the returned function is called. The
   *  browser's own prompt on leaving the document is armed while any is held. */
  readonly guard = (guard: UnsavedGuard): (() => void) => {
    this.guards.add(guard);
    this.armUnload();
    return () => {
      this.guards.delete(guard);
      this.armUnload();
    };
  };

  /** Ask whether the input these forms hold may be dropped; `perform` runs
   *  once it is. Several forms are one question. */
  readonly ask = (guards: UnsavedGuard[], perform: () => void): void => {
    this.question = { guards, perform };
    this.notify();
  };

  readonly answer = (leave: boolean): void => {
    const question = this.question;
    if (!question) return;
    this.question = undefined;
    this.notify();
    if (!leave) return;
    for (const guard of question.guards) guard.discard();
    question.perform();
  };

  /**
   * Open a surface of the current page under its name. `replaces` names every
   * surface it takes the place of, itself included: with one of them already
   * in the address it takes that entry, and otherwise adds one.
   */
  readonly open = (name: string, value: string, replaces: (string | undefined)[]): void => {
    const { location } = this.host;
    const taken = replaces.some((replaced) => replaced !== undefined && openValue(location.search, replaced) !== undefined);
    const target = { ...location, search: withOpen(location.search, replaces, { name, value }) };
    this.request(target, () => {
      const added = this.openings.get(this.position);
      this.write(target, taken);
      // An entry added for a surface this one replaces is now this one's.
      if (!taken || (added && replaces.includes(added.name))) this.openings.set(this.position, { name, path: target.path });
    });
  };

  /**
   * Close one surface: the address as it is, less that surface. Reached by
   * going back when the current entry is the one its opening added, the entry
   * arrived at being brought up to that address; otherwise by replacing the
   * current entry. Nothing is asked: whoever owns a form asks before closing it.
   */
  readonly close = (name: string): void => {
    if (this.returning) {
      // A close already stepping back arrives without this surface too.
      this.returning = { ...this.returning, search: withOpen(this.returning.search, [name]) };
      return;
    }
    const { location } = this.host;
    const target = { ...location, search: withOpen(location.search, [name]) };
    if (this.openings.get(this.position)?.name === name) {
      this.returning = target;
      window.history.back();
    } else this.write(target, true);
  };

  private readonly warnUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = "";
  };

  private armed = false;

  private armUnload(): void {
    const needed = this.guards.size > 0;
    if (needed === this.armed) return;
    this.armed = needed;
    if (needed) window.addEventListener("beforeunload", this.warnUnload);
    else window.removeEventListener("beforeunload", this.warnUnload);
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** The forms holding unsaved input that a location would close. */
  private closedBy(target: HostLocation): UnsavedGuard[] {
    return [...this.guards].filter((guard) => !guard.shows(target));
  }

  /** Move, unless that would close a form holding unsaved input: then ask. */
  private request(target: Target, move: () => void): void {
    const closing = this.closedBy(target);
    if (closing.length === 0) move();
    else this.ask(closing, move);
  }

  private write(target: Target, replace: boolean): void {
    const address = this.prefix + target.path + target.search + target.hash;
    if (replace) {
      const current = this.locationOf(window.location);
      if (current.path !== target.path || current.search !== target.search || current.hash !== target.hash) {
        window.history.replaceState({ [POSITION]: this.position }, "", address);
      }
      const added = this.openings.get(this.position);
      if (added && (added.path !== target.path || openValue(target.search, added.name) === undefined)) this.openings.delete(this.position);
      // The entry after this one was added from the page this one no longer is.
      if (current.path !== target.path) this.openings.delete(this.position + 1);
    } else {
      this.position += 1;
      window.history.pushState({ [POSITION]: this.position }, "", address);
      // Whatever lay ahead is gone.
      for (const position of [...this.openings.keys()]) if (position >= this.position) this.openings.delete(position);
    }
    this.moveTo(target);
  }

  private locationOf(address: { pathname: string; search: string; hash: string }): HostLocation {
    const path = address.pathname.startsWith(this.prefix) ? address.pathname.slice(this.prefix.length) : address.pathname;
    return { path: path || "/", search: address.search, hash: address.hash };
  }

  private hostAt(location: HostLocation): Host {
    return {
      location,
      navigate: this.navigate,
      href: this.href,
      fetch: this.fetch,
      notifyChanged: this.notifyChanged,
      onChanged: this.onChanged,
    };
  }

  private moveTo(location: HostLocation): void {
    const current = this.host.location;
    if (current.path === location.path && current.search === location.search && current.hash === location.hash) return;
    this.host = this.hostAt(location);
    this.notify();
  }

  /** An app-relative reference resolved against the current location, or
   *  nothing when it names a scheme or resolves to another host. */
  private resolveLocal(to: string): Target | undefined {
    const { path, search, hash } = this.host.location;
    const base = new URL(path + search + hash, "http://telo.invalid");
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to)) return undefined;
    let url: URL;
    try {
      url = new URL(to, base);
    } catch {
      // Not a reference a URL can be made of: it resolves to nothing.
      return undefined;
    }
    if (url.origin !== base.origin) return undefined;
    return { path: url.pathname, search: url.search, hash: url.hash };
  }

  private resolve(to: string): Target {
    const target = this.resolveLocal(to);
    if (!target) {
      throw new TypeError(
        `'${to}' is not an app-relative reference: it names a scheme or a host. Use a path, a query or a fragment of this application.`,
      );
    }
    return target;
  }

  /** The address of a reference inside this application, for the renderer's own
   *  links: nothing — never a throw — when it does not resolve inside it. */
  readonly localHref = (to: string): string | undefined => {
    const target = this.resolveLocal(to);
    return target && this.prefix + target.path + target.search + target.hash;
  };

  private readonly navigate = (to: string, options?: { replace?: boolean }): void => {
    const target = this.resolve(to);
    this.request(target, () => this.write(target, options?.replace === true));
  };

  private readonly href = (to: string): string => {
    const target = this.resolve(to);
    return this.prefix + target.path + target.search + target.hash;
  };

  private readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const address = input instanceof Request ? input.url : String(input);
    const sameOrigin = new URL(address, window.location.href).origin === window.location.origin;
    return sameOrigin ? globalThis.fetch(input, { credentials: "same-origin", ...init }) : globalThis.fetch(input, init);
  };

  private readonly notifyChanged = (basePath: string): void => {
    for (const listener of [...(this.changes.get(basePath) ?? [])]) listener();
  };

  private readonly onChanged = (basePath: string, listener: () => void): (() => void) => {
    const listeners = this.changes.get(basePath) ?? new Set();
    this.changes.set(basePath, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

export const HostContext = createContext<HostStore | null>(null);

/** The store behind the application being rendered. */
export function useHostStore(): HostStore {
  const store = useContext(HostContext);
  if (!store) {
    throw new Error("The renderer drew a node outside an application.");
  }
  return store;
}

/** The host object; the caller re-renders when `location` changes. */
export function useHost(): Host {
  const store = useContext(HostContext);
  if (!store) {
    throw new Error("useHost() was called outside a component the host renders.");
  }
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
