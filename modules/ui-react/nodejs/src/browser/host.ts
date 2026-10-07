import { createContext, useContext, useSyncExternalStore } from "react";
import type { Host, HostLocation } from "../contract/ui-react.js";

export type { Host, HostLocation };

/** An app-relative reference, resolved. */
interface Target {
  path: string;
  search: string;
  hash: string;
}

/**
 * The state behind `useHost`: where the page is, and who listens for a
 * collection changing. One per rendered application.
 */
export class HostStore {
  private host: Host;
  private readonly watchers = new Set<() => void>();
  private readonly changes = new Map<string, Set<() => void>>();

  /** `prefix` is the mount path with no trailing slash; empty at the root. */
  constructor(readonly prefix: string) {
    this.host = this.hostAt(this.locationOf(window.location));
  }

  readonly subscribe = (watcher: () => void): (() => void) => {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  };

  readonly snapshot = (): Host => this.host;

  /** Take the browser's own address as the location — after back or forward. */
  readonly syncFromAddress = (): void => this.moveTo(this.locationOf(window.location));

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
    for (const watcher of [...this.watchers]) watcher();
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
    const address = this.prefix + target.path + target.search + target.hash;
    if (options?.replace) window.history.replaceState(null, "", address);
    else window.history.pushState(null, "", address);
    this.moveTo(target);
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
