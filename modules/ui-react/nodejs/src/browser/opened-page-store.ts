import { HostStore, type HostLocation, type Target, type UnsavedGuard } from "./host.js";
import { withOpen } from "./open-address.js";

/** Where a page opened over another is, and how it goes away. */
export interface OpenedPageScope {
  /** Whether the opened page is still shown at a location of the application. */
  stays(target: HostLocation): boolean;
  /** The application moved on from the opened page: it closes. */
  leave(): void;
}

/** An app-relative address as a location. */
export function locationAt(address: string): HostLocation {
  const url = new URL(address, "http://telo.invalid");
  return { path: url.pathname, search: url.search, hash: url.hash };
}

/**
 * The store of a page opened in a surface over the application's page. Its
 * location starts at the page's address and is kept in memory: what the page's
 * own nodes write into the address — an open surface, a filter bar's or a
 * form's kept state — moves it and never the application's. A move to another
 * path, and every destination moving somewhere, moves the application, which
 * closes the page. What collections change, what is asked about unsaved input
 * and what the page's forms hold unsaved are the application's.
 */
export class OpenedPageStore extends HostStore {
  /** Stands in the application's store for every form here holding unsaved input. */
  private readonly unsaved: UnsavedGuard;
  private released?: () => void;

  constructor(
    private readonly application: HostStore,
    address: string,
    private readonly scope: OpenedPageScope,
  ) {
    super(application.prefix, { at: locationAt(address), shares: application });
    this.unsaved = {
      shows: (target) => scope.stays(target),
      discard: () => {
        for (const guard of [...this.guards]) guard.discard();
      },
    };
  }

  /** What closing the page would lose: the forms here holding unsaved input, as one. */
  pending(): UnsavedGuard[] {
    return this.guards.size > 0 ? [this.unsaved] : [];
  }

  protected override guarded(): void {
    if (this.guards.size > 0 && this.released === undefined) this.released = this.application.guard(this.unsaved);
    else if (this.guards.size === 0 && this.released !== undefined) {
      this.released();
      this.released = undefined;
    }
  }

  protected override askAbout(guards: UnsavedGuard[], perform: () => void): void {
    this.application.ask(guards, perform);
  }

  protected override write(target: Target): void {
    this.moveTo(target);
  }

  protected override openSurface(name: string, value: string, replaces: (string | undefined)[]): void {
    const { location } = this.host;
    const target = { ...location, search: withOpen(location.search, replaces, { name, value }) };
    this.request(target, () => this.write(target));
  }

  protected override closeSurface(name: string): void {
    const { location } = this.host;
    this.write({ ...location, search: withOpen(location.search, [name]) });
  }

  protected override navigateTo(to: string): void {
    const target = this.resolve(to);
    if (target.path !== this.host.location.path) return this.leaveTo(target);
    this.request(target, () => this.write(target));
  }

  override follow(to: string): void {
    this.leaveTo(this.resolve(to));
  }

  /** Move the application, which closes the page. */
  private leaveTo(target: Target): void {
    this.application.go(target.path + target.search + target.hash, () => this.scope.leave(), this.pending());
  }
}
