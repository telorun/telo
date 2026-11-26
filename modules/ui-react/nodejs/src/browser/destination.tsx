import { createContext, useContext, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode, type Ref } from "react";
import { addressReads, resolveAddress, type AddressWire } from "./address-wire.js";
import { CurrentAnchor, type Lead } from "./current-location.js";
import { useHostStore, type HostStore } from "./host.js";
import { linkAddress, pageAddress } from "./link-address.js";
import { RendererContext } from "./renderer-context.js";
import type { SurfaceSpec } from "./surface.js";

/** A destination opening a page in a surface, as the page document carries it. */
export type OpenPageWire = { type: "openPage"; href: AddressWire; surface: SurfaceSpec; keepsSurface: boolean };

/**
 * Where a `to` leads, as the page document carries it: one branch per kind of
 * destination, each with the address it leads to. An opened page carries the
 * surface it opens in, filled, and whether a press inside an opened page keeps
 * that page's surface instead.
 */
export type DestinationWire = { type: "navigate"; href: AddressWire } | OpenPageWire;

/** A destination with its address resolved over the roots where its `to` is written. */
export interface ResolvedDestination {
  to: DestinationWire;
  address: string;
}

/** A destination over the roots in scope, or nothing when its address does not resolve (reported once). */
export function resolveDestination(to: DestinationWire | undefined, roots: Readonly<Record<string, unknown>>, where: string): ResolvedDestination | undefined {
  if (to === undefined) return undefined;
  const address = resolveAddress(to.href, roots, where);
  return address === undefined ? undefined : { to, address };
}

/** Where a resolved destination leads, for the test of whether that is where the viewer is. */
export const leadOf = (destination: ResolvedDestination): Lead => ({ type: destination.to.type, address: destination.address });

/** Whether a destination's address reads the named root. */
export const destinationReads = (to: DestinationWire | undefined, root: string): boolean => to !== undefined && addressReads(to.href, root);

/** The place a listing keeps under one of its records for an inline surface. */
export interface DetailSlot {
  /** Make the place exist and tell where it is, `null` while it is not drawn; the returned function gives it up. */
  show(report: (element: HTMLElement | null) => void): () => void;
}

/** What a listing hands what is pressed inside its records: the place under the record a row is. */
export const DetailContext = createContext<((row: Record<string, unknown>) => DetailSlot | undefined) | null>(null);

/** A page to open in a surface, as a press, a link, an entry or a success asks for it. */
export interface PageOpening {
  to: OpenPageWire;
  /** The page's address, resolved where the `to` is written. */
  address: string;
  /** The text or label naming what opened it: the surface's title when the page has none. */
  naming: string;
  /** The element that opened it, which the focus returns to when it closes. */
  opener: HTMLElement | null;
  /** Where an inline surface is drawn under the record that opened it, where a listing's record did. */
  detail?: DetailSlot;
}

/** What hosts the opened page: the application shell, told whether the opening is pressed inside the page it holds. */
export interface PageHost {
  open(opening: PageOpening): void;
}

/** The host of opened pages where this is drawn; absent outside an application. */
export const PageHostContext = createContext<PageHost | null>(null);

/** Where a destination is gone to from: its resolved address, and the application it is pressed in. */
export interface DestinationContext {
  /** The destination's address, resolved over the roots where its `to` is written. */
  address: string;
  store: HostStore;
  /** Mount path with no trailing slash; empty at the root. */
  prefix: string;
  /** The paths of the pages the application declares. */
  pages: readonly string[];
  /** What opens a page in a surface. */
  pageHost: PageHost | null;
}

/** What names the destination gone to, and the element it is gone to from. */
export interface DestinationOrigin {
  /** The text or label of what is pressed. */
  naming: string;
  /** The element pressed: the element with the focus when not given. */
  opener?: HTMLElement | null;
  /** The place under the record, where what is pressed is one. */
  detail?: DetailSlot;
}

/** What every destination pressed here is gone to from, less its address. */
export function useDestinationContext(): Omit<DestinationContext, "address"> {
  const store = useHostStore();
  const { prefix, pages } = useContext(RendererContext);
  const pageHost = useContext(PageHostContext);
  return { store, prefix, pages, pageHost };
}

/**
 * Where following an address moves within the application: the path, query and
 * fragment of an address a declared page opens. Nothing when following it is a
 * load of the address in place of the document, or when no link may hold it.
 */
function withinApplication(context: DestinationContext): string | undefined {
  const href = linkAddress(context.store, context.address);
  return href === undefined ? undefined : pageAddress(context.prefix, context.pages, href);
}

/**
 * Follow an address: a move of the application to a page it declares — from
 * inside an opened page too, which that closes — else a load of the address.
 * One no link may hold goes nowhere. Resolves with whether it went: a move the
 * user chose to stay for did not.
 */
export function followAddress(context: DestinationContext): Promise<boolean> {
  const within = withinApplication(context);
  if (within !== undefined) return context.store.follow(within);
  const href = linkAddress(context.store, context.address);
  if (href === undefined) return Promise.resolve(false);
  context.store.leave(href);
  return Promise.resolve(true);
}

/** The element with the focus, when one other than the document's body has it. */
function focused(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Go where a destination leads. Every press, link, entry and success that
 * holds a `to` goes through here: an address is followed, a page is opened in
 * its surface by the application shell. Resolves once it has gone, with
 * whether it did.
 */
export function openDestination(to: DestinationWire, context: DestinationContext, origin: DestinationOrigin): Promise<boolean> {
  switch (to.type) {
    case "navigate":
      return followAddress(context);
    case "openPage":
      if (context.pageHost === null) throw new Error("The renderer opened a page outside an application.");
      context.pageHost.open({ to, address: context.address, naming: origin.naming, opener: origin.opener ?? focused(), detail: origin.detail });
      return Promise.resolve(true);
  }
}

/**
 * Whether going to a destination is a load of its address in place of the
 * document — what the browser does itself when its link is followed. An opened
 * page never is: the shell opens it.
 */
export function destinationLoads(to: DestinationWire, context: DestinationContext): boolean {
  switch (to.type) {
    case "navigate":
      return withinApplication(context) === undefined;
    case "openPage":
      return false;
  }
}

/** Whether a click on an anchor is the browser's: modified, not the primary button, or an anchor opening elsewhere or downloading. */
function leftToBrowser(event: MouseEvent<HTMLAnchorElement>): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
  const anchor = event.currentTarget;
  return anchor.getAttribute("target") !== null || anchor.hasAttribute("download");
}

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & { ref?: Ref<HTMLAnchorElement> };

/**
 * A destination drawn as a real link to its address — `href` that address as
 * the browser reaches it — so it opens in a new tab like any link. An
 * unmodified click goes to the destination; any other click, and one whose
 * destination is a load of its address, is the browser's. `naming` is the
 * text naming it, an opened page's title when the page has none.
 */
export function DestinationAnchor({
  destination,
  href,
  naming,
  detail,
  onClick,
  ...rest
}: { destination: ResolvedDestination; href: string; naming: string; detail?: DetailSlot } & AnchorProps): ReactNode {
  const context = useDestinationContext();
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const at = { ...context, address: destination.address };
    if (leftToBrowser(event) || destinationLoads(destination.to, at)) return;
    event.preventDefault();
    openDestination(destination.to, at, { naming, opener: event.currentTarget, detail });
  };
  return <CurrentAnchor {...rest} lead={leadOf(destination)} href={href} onClick={follow} />;
}
