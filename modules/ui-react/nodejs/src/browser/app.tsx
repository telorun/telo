import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ViewerContext, type Viewer } from "./current-location.js";
import { PageHostContext } from "./destination.js";
import { BUILT_IN, ControlsContext, loadControls, type ControlsField, type EffectiveControls } from "./effective-controls.js";
import { HostContext, HostStore } from "./host.js";
import { anchorMove } from "./link-address.js";
import { matchPage } from "./page-route.js";
import { ErrorNode, Loading, Nodes, type SpecNode } from "./nodes.js";
import { openedLocation, OpenedPageSurface, useOpenedPage, type SearchedDocument } from "./opened-page.js";
import { MutationRunner, MutationRunnerContext } from "./mutation-call.js";
import { FormRecords, FormRecordsContext } from "./form-records.js";
import { fetchDocument, fetchNotFound, type PageDocument } from "./page-documents.js";
import { LayoutFrame, type LayoutDocument } from "./layout.js";
import { queryRoot } from "./query-root.js";
import { RendererContext, RootsContext, type RendererEnvironment } from "./renderer-context.js";
import { Confirmation } from "./surface.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";
import { DEFAULT_TOASTER, ToasterHost, type ToasterPlacement } from "./toaster-host.js";
import { formatOwn, formatText, NO_TEXTS, TextsContext, type Texts, type TranslatedText } from "./texts.js";

interface AppDocument {
  bundle: string;
  digest: string;
  title: TranslatedText;
  /** The language the documents are in: a catalog's, else the application's own. */
  lang?: string;
  /** Every page the application serves, by its declared path: what a move within it may reach,
   *  and the id of the layout it is drawn in (none: drawn bare). */
  pages: { path: string; title?: TranslatedText; layout?: string }[];
  /** The id of the default layout, which an unknown path is drawn in. */
  layout?: string;
  /** The keyed texts in the request's language, and the set the renderer's own are drawn from. */
  texts: Texts;
  stylesheets: string[];
  /** The mechanics stylesheet of each built-in control in use, and the theme's control sets. */
  controls: ControlsField;
  /** The viewport width below which every compact surface applies, a CSS length. */
  compactBelow: string;
  /** Where the application's toaster sits; bottom and end when not given. */
  toaster?: ToasterPlacement;
}

export interface AppProps {
  /** Mount path with no trailing slash; empty at the root. */
  prefix: string;
  /** The digest of the renderer that is running. */
  bundle: string;
  /** What a renderer newer than this one calls for. */
  reload?: () => void;
  loadModule?: RendererEnvironment["loadModule"];
}

/** How long a stylesheet may hold the first drawing back before the page is
 *  drawn without it. */
const STYLESHEET_WAIT_MS = 5000;

/** Keep the page's stylesheet links equal to the list, in its order. Settles
 *  once every one it added has loaded, has failed, or has taken too long. */
function applyStylesheets(urls: string[]): Promise<void> {
  const links = [...document.head.querySelectorAll<HTMLLinkElement>("link[data-telo-stylesheet]")];
  if (links.map((link) => link.getAttribute("href")).join("\n") === urls.join("\n")) return Promise.resolve();
  for (const link of links) link.remove();
  const settled = urls.map((url) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.setAttribute("data-telo-stylesheet", "");
    const done = new Promise<void>((resolve) => {
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener("error", () => resolve(), { once: true });
    });
    document.head.append(link);
    return done;
  });
  return Promise.race([Promise.all(settled).then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, STYLESHEET_WAIT_MS))]);
}

/** The last boundary: whatever no node's own boundary caught is shown as the
 *  error node, so the document is never left blank. */
class RootBoundary extends Component<{ children: ReactNode }, { error?: ErrorSpec }> {
  state: { error?: ErrorSpec } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: errorSpec(error, "ERR_UI_NODE_INVALID") };
  }

  render() {
    return this.state.error ? <ErrorNode error={this.state.error} /> : this.props.children;
  }
}

/** The application, inside the last boundary. */
export function App(props: AppProps) {
  return (
    <RootBoundary>
      <Application {...props} />
    </RootBoundary>
  );
}

/**
 * The application: its header and navigation around the current page. It
 * fetches the application document once and a page document per page, follows
 * the address bar, and re-fetches when the server says it may have changed.
 */
function Application({ prefix, bundle, reload = () => window.location.reload(), loadModule }: AppProps) {
  const store = useMemo(() => new HostStore(prefix), [prefix]);
  const host = useSyncExternalStore(store.subscribe, store.snapshot);
  const asking = useSyncExternalStore(store.subscribe, store.asking);
  const [app, setApp] = useState<AppDocument>();
  const compact = useCompact(app?.compactBelow);
  const base = useEnvironment(loadModule, prefix, compact, app?.pages, app?.lang);
  // The controls the application draws with, once its theme's sets are loaded.
  const [controls, setControls] = useState<EffectiveControls>();
  const [page, setPage] = useState<PageDocument>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [refreshes, setRefreshes] = useState(0);
  // Nothing is drawn before the first stylesheets are in: an unstyled page is
  // worse than the shell's spinner, which shows while the root is empty.
  const [styled, setStyled] = useState(false);
  const held = useRef<{ app?: AppDocument; page?: PageDocument; layouts: Map<string, LayoutDocument> }>({ layouts: new Map() });
  const [layouts, setLayouts] = useState<ReadonlyMap<string, LayoutDocument>>(new Map());
  // What an undeclared path was answered with; `children` is absent when the server sent none.
  const [missing, setMissing] = useState<{ path: string; children?: SpecNode[] }>();
  const path = host.location.path;
  // The page the address opens, and the variables it fills.
  const matched = useMemo(() => (app ? matchPage(app.pages.map((candidate) => candidate.path), path) : undefined), [app, path]);
  const declared = matched && app?.pages.find((candidate) => candidate.path === matched.path);
  // A page names its layout; an undeclared path is drawn in the default one.
  const layoutId = app === undefined ? undefined : declared ? declared.layout : app.layout;

  const accept = <T extends { bundle: string }>(document: T): T | undefined => {
    if (document.bundle === bundle) return document;
    // The server holds a newer renderer than the one running.
    reload();
    return undefined;
  };

  useEffect(() => {
    window.addEventListener("popstate", store.syncFromAddress);
    return () => window.removeEventListener("popstate", store.syncFromAddress);
  }, [store]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`${prefix}/_telo/ui/events`, { withCredentials: true });
    let connected = false;
    source.addEventListener("hello", (event) => {
      if (JSON.parse((event as MessageEvent).data).bundle !== bundle) return reload();
      // A second hello is a reconnect: what was fetched may be stale.
      if (connected) setRefreshes((count) => count + 1);
      connected = true;
    });
    return () => source.close();
  }, [prefix, bundle]);

  useEffect(() => {
    let current = true;
    fetchDocument(host, `${prefix}/_telo/ui/app`, held.current.app).then(
      (fetched) => {
        const accepted = accept(fetched);
        if (!current || !accepted) return;
        held.current.app = accepted;
        setApp(accepted);
      },
      (error) => current && setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED")),
    );
    return () => {
      current = false;
    };
  }, [prefix, refreshes]);

  // One document per declared page: a move to another value of its variables fetches none.
  useEffect(() => {
    if (!app) return;
    let current = true;
    if (!declared) {
      fetchNotFound(host, `${prefix}/_telo/ui/page?path=${encodeURIComponent(path)}`).then(
        (children) => {
          if (!current) return;
          setMissing({ path, children });
          setFailure(undefined);
        },
        (error) => current && setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED")),
      );
      return () => {
        current = false;
      };
    }
    const holding = held.current.page?.path === declared.path ? held.current.page : undefined;
    if (!holding) setPage(undefined);
    fetchDocument(host, `${prefix}/_telo/ui/page?path=${encodeURIComponent(path)}`, holding).then(
      (fetched) => {
        const accepted = accept(fetched);
        if (!current || !accepted) return;
        held.current.page = accepted;
        setPage(accepted);
        setFailure(undefined);
      },
      (error) => current && setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED")),
    );
    return () => {
      current = false;
    };
  }, [prefix, app !== undefined, declared?.path, declared ? undefined : path, refreshes]);

  // The layout is revalidated with each page document, and whenever the stream reconnects:
  // a 304 keeps it, a new digest redraws it in place.
  useEffect(() => {
    if (layoutId === undefined) return;
    let current = true;
    const holding = held.current.layouts.get(layoutId);
    fetchDocument(host, `${prefix}/_telo/ui/layout?id=${encodeURIComponent(layoutId)}`, holding).then(
      (fetched) => {
        const accepted = accept(fetched);
        if (!current || !accepted) return;
        if (accepted === holding) return;
        held.current.layouts.set(layoutId, accepted);
        setLayouts(new Map(held.current.layouts));
      },
      (error) => current && setFailure(errorSpec(error, "ERR_UI_REQUEST_FAILED")),
    );
    return () => {
      current = false;
    };
  }, [prefix, layoutId, declared?.path, declared ? undefined : path, refreshes]);

  const sets = JSON.stringify(app?.controls.sets ?? null);
  useEffect(() => {
    if (!app) return;
    let current = true;
    void loadControls(app.controls.sets, base.loadModule).then((loaded) => current && setControls(loaded));
    return () => {
      current = false;
    };
  }, [sets]);

  useEffect(() => {
    if (!app) return;
    let current = true;
    void applyStylesheets([...app.stylesheets, ...Object.values(app.controls.stylesheets)]).then(() => current && setStyled(true));
    const title = formatText(app.texts, app.title, {});
    document.title = declared?.title ? `${formatText(app.texts, declared.title, {})} · ${title}` : title;
    if (app.lang === undefined) document.documentElement.removeAttribute("lang");
    else document.documentElement.lang = app.lang;
    return () => {
      current = false;
    };
  }, [app, declared]);

  /** A plain click on an anchor to a page this application declares moves the
   *  page without leaving it. Anything else is the browser's. */
  const followAnchor = (event: MouseEvent) => {
    const to = anchorMove(event, prefix, base.pages);
    if (to !== undefined) host.navigate(to);
  };

  const shown = declared !== undefined && page?.path === declared.path ? page : undefined;
  const paramsKey = JSON.stringify(matched?.params ?? {});
  const pageRoots = useMemo(
    () => ({ query: queryRoot(shown?.query, host.location.search), params: matched?.params ?? {} }),
    [shown?.query, host.location.search, paramsKey],
  );
  // Another value of a variable is another record: the page is drawn afresh.
  const drawing = `${declared?.path ?? ""}\u0000${paramsKey}`;
  // The page's runner: a serial mutation's calls are ordered within one page, and what a success does is the runner's.
  const runner = useMemo(() => new MutationRunner(), [path]);
  // The page's forms: the settled record each holds, which a query or listing naming it reads.
  const forms = useMemo(() => new FormRecords(), [drawing]);
  const layout = layoutId === undefined ? undefined : layouts.get(layoutId);
  const arranged = layoutId === undefined || layout !== undefined;
  const absent = !declared && missing?.path === path ? missing : undefined;
  const state = failure ? "error" : !app ? "loading" : !declared ? (absent ? "empty" : "loading") : shown ? "idle" : "loading";
  // The last page delivered keeps its width while the next one loads; a path no
  // page declares has none, whichever page came before it.
  const width = declared ? (shown ?? held.current.page)?.width : undefined;
  // A page fills while one of its own nodes does.
  const fill = !failure && shown?.children.some((child: SpecNode) => child.fill === true) ? "true" : undefined;
  // What a page key's surface is looked for in, once the route's documents are in: the page's nodes, then its layout's regions.
  const layoutRoots = useMemo(() => ({ query: queryRoot(undefined, host.location.search), params: {} }), [host.location.search]);
  const routeNodes = !app || !arranged ? undefined : declared ? shown?.children : absent ? (absent.children ?? []) : undefined;
  const documents = useMemo<SearchedDocument[] | undefined>(
    () =>
      routeNodes === undefined
        ? undefined
        : [
            { nodes: routeNodes, roots: pageRoots },
            ...(layout === undefined ? [] : [layout.header, layout.aside, layout.footer].map((nodes) => ({ nodes, roots: layoutRoots }))),
          ],
    [routeNodes, layout, pageRoots, layoutRoots],
  );
  const untitled = app === undefined ? "" : formatText(app.texts, app.title, {});
  const pages = useOpenedPage({ store, location: host.location, documents, untitled, texts: app?.texts ?? NO_TEXTS });
  const opened = openedLocation(pages.opened);
  const viewer = useMemo<Viewer>(() => ({ location: host.location, ...(opened === undefined ? {} : { opened }) }), [host.location, opened?.path, opened?.search]);
  // A failure is drawn whatever the styles: it must never be a spinner forever.
  if (!failure && (!styled || !controls)) return null;
  const texts = app?.texts ?? NO_TEXTS;
  const say = (key: string, values?: Readonly<Record<string, string>>) => formatOwn(texts, key, values);
  return (
    <TextsContext.Provider value={texts}>
    <ControlsContext.Provider value={controls ?? BUILT_IN}>
    <HostContext.Provider value={store}>
      <RendererContext.Provider value={base}>
      <ViewerContext.Provider value={viewer}>
      <PageHostContext.Provider value={pages.outside}>
        <LayoutFrame key={layoutId ?? ""} layout={layout} compact={compact} fill={fill} onClick={followAnchor}>
          <main data-telo-part="main" data-fill={fill}>
            <div data-telo-part="page" data-state={state} data-width={width} data-fill={fill}>
              {failure ? (
                <ErrorNode error={failure} />
              ) : !app || !arranged ? (
                <Loading />
              ) : !declared ? (
                absent ? (
                  absent.children ? (
                    <Nodes nodes={absent.children} />
                  ) : (
                    <>
                      <h1 data-telo-part="text">{say("notFound")}</h1>
                      <p data-telo-part="text">{say("noPageAt", { path })}</p>
                    </>
                  )
                ) : (
                  <Loading />
                )
              ) : (
                shown ? (
                  <MutationRunnerContext.Provider key={drawing} value={runner}>
                    <FormRecordsContext.Provider value={forms}>
                      <RootsContext.Provider value={pageRoots}>
                        <Nodes nodes={shown.children} />
                      </RootsContext.Provider>
                    </FormRecordsContext.Provider>
                  </MutationRunnerContext.Provider>
                ) : (
                  <Loading />
                )
              )}
            </div>
          </main>
        </LayoutFrame>
        {pages.opened && app && (
          <OpenedPageSurface opened={pages.opened} pages={app.pages} inside={pages.inside} accept={accept} refreshes={refreshes} onClose={pages.close} closeOf={pages.closeOf} />
        )}
        {app && <ToasterHost placement={app.toaster ?? DEFAULT_TOASTER} runner={runner} />}
      </PageHostContext.Provider>
        {asking && (
          <Confirmation
            title={say("unsavedQuestion")}
            description={say("unsavedDetail")}
            confirm={say("discard")}
            cancel={say("keepEditing")}
            onConfirm={() => store.answer(true)}
            onClose={() => store.answer(false)}
          />
        )}
      </ViewerContext.Provider>
      </RendererContext.Provider>
    </HostContext.Provider>
    </ControlsContext.Provider>
    </TextsContext.Provider>
  );
}

function useEnvironment(
  loadModule: AppProps["loadModule"],
  prefix: string,
  compact: boolean,
  declared: AppDocument["pages"] | undefined,
  lang: string | undefined,
): RendererEnvironment {
  return useMemo(
    () => ({
      prefix,
      loadModule: loadModule ?? ((url: string) => import(/* @vite-ignore */ url)),
      compact,
      pages: (declared ?? []).map((page) => page.path),
      lang: lang ?? "und",
    }),
    [prefix, loadModule, compact, declared, lang],
  );
}

/** Whether the viewport is narrower than the application's breakpoint. */
function useCompact(below: string | undefined): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (below === undefined || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(width < ${below})`);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [below]);
  return compact;
}

/** What a host mounting the renderer may give it. */
export interface MountOptions {
  /** How a browser module — a component library, a theme's controls — is
   *  loaded by URL; the platform's `import()` when not given. */
  loadModule?: RendererEnvironment["loadModule"];
}

/** Render the application into the shell's root element, which says where it
 *  is mounted and which renderer it was served with. */
export function mount(root: HTMLElement, options: MountOptions = {}): Root {
  const rendered = createRoot(root);
  rendered.render(<App prefix={root.dataset.teloMount ?? ""} bundle={root.dataset.teloBundle ?? ""} loadModule={options.loadModule} />);
  return rendered;
}
