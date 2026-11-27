import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { isAppRelative, type CurrentLocation } from "./address-wire.js";
import { readBinding } from "./bindings.js";
import { PageHostContext, type DetailSlot, type PageHost, type PageOpening } from "./destination.js";
import { HostContext, type HostLocation, type HostStore } from "./host.js";
import { anchorMove } from "./link-address.js";
import { ErrorNode, Loading, Nodes, type SpecNode } from "./nodes.js";
import { anchorOf } from "./node-anchors.js";
import { locationAt, OpenedPageStore } from "./opened-page-store.js";
import { MutationRunner, MutationRunnerContext } from "./mutation-call.js";
import { FormRecords, FormRecordsContext } from "./form-records.js";
import { fetchDocument, fetchNotFound, type PageDocument } from "./page-documents.js";
import { pageEntries, pageKey, sameSurface, surfaceDeclaring, type DeclaredSurface } from "./page-key.js";
import { matchPage } from "./page-route.js";
import { queryRoot } from "./query-root.js";
import { OpenedPageContext, RendererContext, RootsContext } from "./renderer-context.js";
import { Surface, type SurfaceSpec } from "./surface.js";
import { formatText, TextsContext, useSay, type Texts, type TranslatedText, type WireText } from "./texts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

/** A page open in a surface over the application's page. */
export interface OpenedPage {
  /** The surface it is drawn in, filled. */
  surface: SurfaceSpec;
  /** The page's app-relative address. */
  address: string;
  /** The name of the surface whose page key keeps the address; absent when the page is held in memory. */
  name: string | undefined;
  /** The text naming what opened it: its title when the page has none. */
  naming: string;
  /** The element on the application's page that opened what is shown, which gets the focus back. */
  opener: HTMLElement | null;
  /** The application path it was opened on: one held in memory closes when the application leaves it. */
  on: string;
  /** The record of the listing that opened it, under which an inline surface is drawn. */
  detail: DetailSlot | undefined;
  /** Whether a form in it is being sent: nothing closes it or replaces it meanwhile. */
  busy: { current: boolean };
  /** Whether what opened it was on screen when it opened — or, cold, what stands in for it was — so a surface placed against it can be. Decided at open. */
  placed: boolean;
  /** The page's own store, its addresses in memory. */
  store: OpenedPageStore;
  /** Which drawing of a surface it is in: a page swapped into the open surface keeps the drawing. */
  frame: number;
  /** Which opening it is: each draws its content afresh. */
  serial: number;
}

/** A document a page key's surface is looked for in, and the roots its texts are formatted over. */
export interface SearchedDocument {
  nodes: unknown;
  roots: Readonly<Record<string, unknown>>;
}

/** A text formatted over roots, or nothing when a value it reads is not there. */
function boundText(texts: Texts, text: WireText, roots: Readonly<Record<string, unknown>>): string | undefined {
  if ("message" in text) for (const binding of Object.values(text.values ?? {})) if (!readBinding(binding, roots).present) return undefined;
  return formatText(texts, text, roots);
}

/**
 * The application shell's one opened page: opened by a destination, restored
 * from its page key, closed — dropping its key — by Escape, its close button,
 * the application moving on, or the key leaving the address. `documents` are
 * the current route's page document and its layout's regions, in that order,
 * absent while any is still loading; `untitled` names a page restored from
 * the address that has no title and whose declaring text cannot be formatted.
 */
export function useOpenedPage({
  store,
  location,
  documents,
  untitled,
  texts,
}: {
  store: HostStore;
  location: HostLocation;
  documents: readonly SearchedDocument[] | undefined;
  untitled: string;
  /** The application's texts, which the shell is drawn above. */
  texts: Texts;
}): { opened: OpenedPage | undefined; outside: PageHost; inside: PageHost; close(): void; closeOf(page: HostStore): () => void } {
  const [opened, setOpened] = useState<OpenedPage>();
  // What is open now, ahead of the render that draws it.
  const held = useRef<OpenedPage | undefined>(undefined);
  const frames = useRef(0);
  const serials = useRef(0);
  const searched = useRef(documents);
  searched.current = documents;
  const focusing = useRef<HTMLElement | null>(null);

  const change = (next: OpenedPage | undefined) => {
    if (next === undefined && held.current !== undefined) focusing.current = held.current.opener;
    held.current = next;
    setOpened(next);
  };

  const pageStore = (address: string, name: string | undefined, on: string): OpenedPageStore => {
    const page: OpenedPageStore = new OpenedPageStore(store, address, {
      stays: (target) => (name === undefined ? target.path === on : new URLSearchParams(target.search).get(pageKey(name)) === address),
      leave: () => {
        if (held.current?.store === page) change(undefined);
      },
    });
    return page;
  };

  /** The surface a reload would restore a page key into: the first declaring it, in the documents searched. */
  const declared = (name: string): DeclaredSurface | undefined => (searched.current === undefined ? undefined : surfaceDeclaring(name, searched.current.map((each) => each.nodes)));

  const open = (opening: PageOpening, inside: boolean) => {
    const current = held.current;
    if (current?.busy.current) return;
    const kept = inside && opening.to.keepsSurface && current !== undefined;
    const surface = kept ? current.surface : opening.to.surface;
    const swaps = current !== undefined && (kept || sameSurface(surface, current.surface));
    // Kept in the address only where a reload would restore the very surface it opens in.
    const named = surface.address?.name;
    const name = named !== undefined && sameSurface(declared(named)?.surface, surface) ? named : undefined;
    const perform = () => {
      store.openPage(name, opening.address, current !== undefined);
      const on = store.snapshot().location.path;
      change({
        surface,
        address: opening.address,
        name,
        naming: opening.naming,
        opener: inside && current !== undefined ? current.opener : opening.opener,
        detail: inside && current !== undefined ? current.detail : opening.detail,
        placed: inside && current !== undefined ? current.placed : !opening.unplaced && ((opening.opener?.isConnected ?? false) || opening.detail !== undefined),
        busy: { current: false },
        on,
        store: pageStore(opening.address, name, on),
        frame: swaps ? current.frame : ++frames.current,
        serial: ++serials.current,
      });
    };
    const pending = current?.store.pending() ?? [];
    if (pending.length > 0) store.ask(pending, perform);
    else perform();
  };

  const close = () => {
    const current = held.current;
    if (current === undefined || current.busy.current) return;
    const perform = () => {
      store.closePage();
      change(undefined);
    };
    const pending = current.store.pending();
    if (pending.length > 0) store.ask(pending, perform);
    else perform();
  };

  /** What closes the page opened at `page`, if it is still the one open. */
  const closeOf = (page: HostStore) => () => {
    if (held.current?.store === page) close();
  };

  // Closed by the address: its key gone or changed, or — held in memory — the page it was opened on left.
  useEffect(() => {
    const current = held.current;
    if (current === undefined) return;
    const gone = current.name === undefined ? location.path !== current.on : new URLSearchParams(location.search).get(pageKey(current.name)) !== current.address;
    if (gone) change(undefined);
  }, [location.path, location.search]);

  // Restored from the address: the first page key, in query order, holding an
  // app-relative address under a name a destination declares; every other dropped.
  useEffect(() => {
    if (documents === undefined) return;
    const keys = pageEntries(location.search);
    if (keys.length === 0) return;
    let chosen: { name: string; value: string; found: DeclaredSurface } | undefined;
    for (const entry of keys) {
      if (!isAppRelative(entry.value)) continue;
      const found = declared(entry.name);
      if (found === undefined) continue;
      chosen = { ...entry, found };
      break;
    }
    if (keys.length > (chosen === undefined ? 0 : 1)) store.keepOnlyPage(chosen?.name);
    if (chosen === undefined) return;
    const current = held.current;
    if (current?.name === chosen.name && current.address === chosen.value) return;
    const { surface, naming, document, anchors } = chosen.found;
    const named = naming === undefined ? undefined : boundText(texts, naming, documents[document].roots);
    // The declaration stands in for what opened the page, where it is known from the documents and drawn now.
    const standIn = surface.type === "panel" ? anchors.composite : surface.type === "popover" || surface.type === "inline" ? anchors.pressed : undefined;
    const anchor = current?.opener ?? (standIn === undefined ? null : anchorOf(standIn));
    change({
      surface,
      address: chosen.value,
      name: chosen.name,
      naming: named ?? untitled,
      opener: anchor,
      detail: current?.detail,
      placed: anchor !== null,
      busy: { current: false },
      on: location.path,
      store: pageStore(chosen.value, chosen.name, location.path),
      frame: current !== undefined && sameSurface(current.surface, surface) ? current.frame : ++frames.current,
      serial: ++serials.current,
    });
  }, [documents, location.path, location.search]);

  // The focus returns to what opened the page that closed, where that is still drawn.
  useEffect(() => {
    if (opened !== undefined) return;
    const opener = focusing.current;
    focusing.current = null;
    if (opener?.isConnected) opener.focus();
  }, [opened]);

  const outside = useMemo<PageHost>(() => ({ open: (opening) => open(opening, false) }), [store]);
  const inside = useMemo<PageHost>(() => ({ open: (opening) => open(opening, true) }), [store]);
  return { opened, outside, inside, close, closeOf };
}

/** Where the viewer is, beside the application: the address of the page open over it. */
export const openedLocation = (opened: OpenedPage | undefined): CurrentLocation | undefined => (opened === undefined ? undefined : locationAt(opened.address));

/** The surface a page falls back on where what opened it cannot place it: a dialog with its defaults. */
const FALLBACK_DIALOG: SurfaceSpec = { type: "dialog", size: "medium", modal: true, dismiss: { escape: true, outside: true, closeButton: true } };

/** The nodes a panel is drawn beside: the nearest of these that holds what was pressed. */
const COMPOSITES = ["listing", "split", "form", "filters", "chat"].map((part) => `[data-telo-part="${part}"]`).join(",");

/** Whether a surface is placed against what opened it, rather than against the viewport. */
const isPlaced = (surface: SurfaceSpec): boolean => surface.type === "popover" || surface.type === "inline" || surface.type === "panel";

/** The element an inline surface is drawn after: what was pressed, or what a press covers. */
const subjectOf = (opener: HTMLElement): HTMLElement | null => (opener.getAttribute("data-telo-part") === "press" ? opener.parentElement : opener);

/** What an opened page's document came to. */
type Drawing = { path: string; page: PageDocument } | { path: string; missing: SpecNode[] | undefined } | { path: string; failure: ErrorSpec };

/**
 * The opened page in its surface: its own page document — the one a move to
 * its address fetches — titled by the page's title, else by the text naming
 * what opened it. A path no page declares draws the not-found page. Its nodes
 * write their addresses into the page's own store, and its anchors to the
 * application's pages move the application.
 */
export function OpenedPageSurface({
  opened,
  pages,
  inside,
  accept,
  refreshes,
  onClose,
  closeOf,
}: {
  opened: OpenedPage;
  /** The pages the application declares: their paths and titles. */
  pages: readonly { path: string; title?: TranslatedText }[];
  inside: PageHost;
  /** A document of the running renderer, or nothing when the server holds a newer one. */
  accept: <T extends { bundle: string }>(document: T) => T | undefined;
  /** Bumped whenever what was fetched may be stale. */
  refreshes: number;
  onClose: () => void;
  closeOf: (page: HostStore) => () => void;
}): ReactNode {
  const environment = useContext(RendererContext);
  const texts = useContext(TextsContext);
  const anchor = useRef<HTMLElement | null>(opened.opener);
  anchor.current = opened.opener;
  const path = locationAt(opened.address).path;
  const matched = matchPage(
    pages.map((page) => page.path),
    path,
  );
  const declared = matched && pages.find((page) => page.path === matched.path);
  const title = declared?.title ? formatText(texts, declared.title, {}) : opened.naming;

  // What opened the page, where it is still drawn: a surface placed against it has nothing to be placed against otherwise.
  const opener = opened.placed ? opened.opener : null;
  const composite = opener?.closest<HTMLElement>(COMPOSITES) ?? null;
  const placeable = (surface: SurfaceSpec) =>
    surface.type === "popover" ? opener !== null : surface.type === "inline" ? opener !== null || opened.detail !== undefined : surface.type === "panel" ? composite !== null : true;
  const narrow = environment.compact;
  let surface = opened.surface;
  if (surface.compact && (narrow || (isPlaced(surface) && !placeable(surface)))) surface = surface.compact;
  else if (isPlaced(surface) && (narrow || !placeable(surface))) surface = FALLBACK_DIALOG;

  const place = useInlinePlace(opened, surface.type === "inline", opener);
  const container = surface.type === "inline" ? place : surface.type === "panel" ? composite : undefined;
  return (
    <Surface key={opened.frame} spec={surface} title={title} anchor={anchor} container={container} onClose={onClose}>
      <OpenedPageContent
        key={opened.serial}
        opened={opened}
        declaredPath={matched?.path}
        params={matched?.params ?? {}}
        inside={inside}
        accept={accept}
        refreshes={refreshes}
        onClose={onClose}
        closeOf={closeOf}
      />
    </Surface>
  );
}

/**
 * Where an inline surface is drawn: under the record of the listing that opened
 * it, else in line after what was pressed. `null` until that place is drawn.
 */
function useInlinePlace(opened: OpenedPage, inline: boolean, opener: HTMLElement | null): HTMLElement | null {
  const [detail, setDetail] = useState<HTMLElement | null>(null);
  const [after] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const slot = opened.detail;
  useEffect(() => {
    if (!inline || slot === undefined) return;
    const release = slot.show(setDetail);
    return () => {
      release();
      setDetail(null);
    };
  }, [inline, slot, opened.serial]);
  useLayoutEffect(() => {
    if (!inline || slot !== undefined || opener === null) return;
    const subject = subjectOf(opener);
    subject?.after(after);
    return () => after.remove();
  }, [inline, slot, opener, opened.serial]);
  return !inline ? null : slot !== undefined ? detail : opener === null ? null : after;
}

function OpenedPageContent({
  opened,
  declaredPath,
  params,
  inside,
  accept,
  refreshes,
  onClose,
  closeOf,
}: {
  opened: OpenedPage;
  declaredPath: string | undefined;
  params: Readonly<Record<string, string>>;
  inside: PageHost;
  accept: <T extends { bundle: string }>(document: T) => T | undefined;
  refreshes: number;
  onClose: () => void;
  closeOf: (page: HostStore) => () => void;
}): ReactNode {
  const environment = useContext(RendererContext);
  const say = useSay();
  const page = useSyncExternalStore(opened.store.subscribe, opened.store.snapshot);
  const { path } = page.location;
  const [drawing, setDrawing] = useState<Drawing>();
  const held = useRef<PageDocument | undefined>(undefined);
  const closing = useMemo(() => ({ close: onClose, busy: (busy: boolean) => void (opened.busy.current = busy) }), [onClose, opened]);
  const runner = useMemo(() => new MutationRunner(closeOf(opened.store)), [opened.store]);
  // A page opened over another keeps its forms' records apart from the page under it.
  const forms = useMemo(() => new FormRecords(), []);
  const url = `${environment.prefix}/_telo/ui/page?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    let current = true;
    const failed = (error: unknown) => current && setDrawing({ path, failure: errorSpec(error, "ERR_UI_REQUEST_FAILED") });
    if (declaredPath === undefined) {
      fetchNotFound(page, url).then((missing) => current && setDrawing({ path, missing }), failed);
    } else {
      fetchDocument(page, url, held.current).then((fetched) => {
        const accepted = accept(fetched);
        if (!current || !accepted) return;
        held.current = accepted;
        setDrawing({ path, page: accepted });
      }, failed);
    }
    return () => {
      current = false;
    };
  }, [url, declaredPath, refreshes]);

  const shown = drawing?.path === path ? drawing : undefined;
  const document = shown !== undefined && "page" in shown ? shown.page : undefined;
  const paramsKey = JSON.stringify(params);
  const roots = useMemo(() => ({ query: queryRoot(document?.query, page.location.search), params }), [document?.query, page.location.search, paramsKey]);
  const follow = (event: MouseEvent) => {
    const to = anchorMove(event, environment.prefix, environment.pages);
    if (to !== undefined) opened.store.follow(to);
  };
  let content: ReactNode;
  if (shown === undefined) content = <Loading />;
  else if ("failure" in shown) content = <ErrorNode error={shown.failure} />;
  else if ("missing" in shown)
    content = shown.missing ? (
      <Nodes nodes={shown.missing} />
    ) : (
      <>
        <h1 data-telo-part="text">{say("notFound")}</h1>
        <p data-telo-part="text">{say("noPageAt", { path })}</p>
      </>
    );
  else content = <Nodes nodes={shown.page.children} />;
  return (
    <HostContext.Provider value={opened.store}>
      <PageHostContext.Provider value={inside}>
        <OpenedPageContext.Provider value={closing}>
          <div style={{ display: "contents" }} onClick={follow}>
            <MutationRunnerContext.Provider value={runner}>
              <FormRecordsContext.Provider value={forms}>
                <RootsContext.Provider value={roots}>{content}</RootsContext.Provider>
              </FormRecordsContext.Provider>
            </MutationRunnerContext.Provider>
          </div>
        </OpenedPageContext.Provider>
      </PageHostContext.Provider>
    </HostContext.Provider>
  );
}
