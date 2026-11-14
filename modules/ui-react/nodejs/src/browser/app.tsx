import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BUILT_IN, ControlsContext, loadControls, type ControlsField, type EffectiveControls } from "./effective-controls.js";
import { HostContext, HostStore, type Host } from "./host.js";
import { pageAddress } from "./link-address.js";
import { matchPage } from "./page-route.js";
import { ErrorNode, Loading, Nodes, type SpecNode } from "./nodes.js";
import { PressQueueContext, PressQueues } from "./operation.js";
import { LayoutFrame, type LayoutDocument } from "./layout.js";
import { queryRoot } from "./query-root.js";
import { RendererContext, RootsContext, type RendererEnvironment } from "./renderer-context.js";
import { Confirmation, PageSlotContext, type PageSlot } from "./surface.js";
import { errorSpec, networkError, responseError, type ErrorSpec } from "./ui-error.js";
import { formatOwn, formatText, NO_TEXTS, TextsContext, type Texts, type TranslatedText } from "./texts.js";
import type { JsonSchema } from "./validation.js";

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
}

interface PageDocument {
  bundle: string;
  digest: string;
  path: string;
  /** Absent for a page with no title: no heading is drawn. */
  title?: TranslatedText;
  lang?: string;
  /** The query parameters the page's nodes read, by name. */
  query?: Record<string, JsonSchema>;
  /** How wide its content is drawn, filled by the server. */
  width: "contained" | "full";
  children: SpecNode[];
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

/** Fetch a document, conditionally when one is already held: an unchanged
 *  one comes back as the one in hand. */
async function fetchDocument<T extends { digest: string }>(host: Host, url: string, holding?: T): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (holding) headers["if-none-match"] = `"${holding.digest}"`;
  const response = await host.fetch(url, { headers }).catch((error) => {
    throw networkError(error);
  });
  if (response.status === 304 && holding) return holding;
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

/** The not-found nodes the server answers an undeclared path with: none when it sends none. */
async function fetchNotFound(host: Host, url: string): Promise<SpecNode[] | undefined> {
  const response = await host.fetch(url, { headers: { accept: "application/json" } }).catch((error) => {
    throw networkError(error);
  });
  if (response.status !== 404) {
    if (!response.ok) throw await responseError(response);
    throw errorSpec(new Error(`The server answered a page for '${new URL(url, window.location.href).searchParams.get("path")}', which the application does not declare.`), "ERR_UI_REQUEST_FAILED");
  }
  const body = (await response.json().catch(() => undefined)) as { children?: SpecNode[] } | undefined;
  return body?.children;
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
  // A surface drawn in place of the page's content is drawn here, by whoever opened it.
  const [slotElement, setSlotElement] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const slot = useMemo<PageSlot>(
    () => ({
      element: slotElement,
      claim: () => {
        setClaims((count) => count + 1);
        return () => setClaims((count) => count - 1);
      },
    }),
    [slotElement],
  );
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
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest?.("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || href == null || anchor.getAttribute("target") || anchor.hasAttribute("download")) return;
    const to = pageAddress(prefix, base.pages, href);
    if (to === undefined) return;
    event.preventDefault();
    host.navigate(to);
  };

  const shown = declared !== undefined && page?.path === declared.path ? page : undefined;
  const paramsKey = JSON.stringify(matched?.params ?? {});
  const pageRoots = useMemo(
    () => ({ query: queryRoot(shown?.query, host.location.search), params: matched?.params ?? {} }),
    [shown?.query, host.location.search, paramsKey],
  );
  // Another value of a variable is another record: the page is drawn afresh.
  const drawing = `${declared?.path ?? ""}\u0000${paramsKey}`;
  // Serial presses are ordered within one page.
  const queues = useMemo(() => new PressQueues(), [path]);
  const layout = layoutId === undefined ? undefined : layouts.get(layoutId);
  const arranged = layoutId === undefined || layout !== undefined;
  const absent = !declared && missing?.path === path ? missing : undefined;
  const state = failure ? "error" : !app ? "loading" : !declared ? (absent ? "empty" : "loading") : shown ? "idle" : "loading";
  // The last page delivered keeps its width while the next one loads; a path no
  // page declares has none, whichever page came before it.
  const width = declared ? (shown ?? held.current.page)?.width : undefined;
  // A page fills while one of its own nodes does and no page surface stands in for it.
  const fill = !failure && claims === 0 && shown?.children.some((child: SpecNode) => child.fill === true) ? "true" : undefined;
  // A failure is drawn whatever the styles: it must never be a spinner forever.
  if (!failure && (!styled || !controls)) return null;
  const texts = app?.texts ?? NO_TEXTS;
  const say = (key: string, values?: Readonly<Record<string, string>>) => formatOwn(texts, key, values);
  return (
    <TextsContext.Provider value={texts}>
    <ControlsContext.Provider value={controls ?? BUILT_IN}>
    <HostContext.Provider value={store}>
      <RendererContext.Provider value={base}>
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
                <PageSlotContext.Provider value={slot}>
                  <div ref={setSlotElement} style={{ display: "contents" }} />
                  <div style={{ display: claims > 0 ? "none" : "contents" }}>{shown ? (
                    <PressQueueContext.Provider key={drawing} value={queues}>
                      <RootsContext.Provider value={pageRoots}>
                        <Nodes nodes={shown.children} />
                      </RootsContext.Provider>
                    </PressQueueContext.Provider>
                  ) : (
                    <Loading />
                  )}</div>
                </PageSlotContext.Provider>
              )}
            </div>
          </main>
        </LayoutFrame>
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
