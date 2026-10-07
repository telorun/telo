/** Where the page is, in the application's own address space. */
export interface HostLocation {
  /** The current page's declared path, with the mount prefix removed. */
  readonly path: string;
  /** The query string, with its leading `?`, or `""`. */
  readonly search: string;
  /** The fragment, with its leading `#`, or `""`. */
  readonly hash: string;
}

/** What the host gives every component it renders. */
export interface Host {
  readonly location: HostLocation;
  /**
   * Go to an app-relative reference, resolved against the current page:
   * `/done`, `/chat?c=7`, `?c=7`, `#top`. Adds a history entry, or replaces the
   * current one. A reference with a scheme or a host throws `TypeError`.
   */
  navigate(to: string, options?: { replace?: boolean }): void;
  /** The same resolution as `navigate`, as the URL for an anchor — mount prefix included. */
  href(to: string): string;
  /**
   * The platform `fetch`, as the application's own composites call it:
   * same-origin credentials, origin-relative URLs. The `Response` is returned
   * untouched, 401 and 403 included.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Say that the collection at this `basePath` changed. */
  notifyChanged(basePath: string): void;
  /** Call `listener` after each such change; returns the function that stops it. */
  onChanged(basePath: string, listener: () => void): () => void;
}

/**
 * The host object. Callable in any component the host renders; the caller
 * re-renders when `location` changes.
 */
export function useHost(): Host;
