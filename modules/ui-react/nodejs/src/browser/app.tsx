import { Tooltip } from "radix-ui";
import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostContext, HostStore, type Host } from "./host.js";
import { ErrorNode, Loading, Nodes, type SpecNode } from "./nodes.js";
import { RendererContext, type RendererEnvironment } from "./renderer-context.js";
import { errorSpec, networkError, responseError, type ErrorSpec } from "./ui-error.js";

interface AppDocument {
  bundle: string;
  digest: string;
  title: string;
  lang?: string;
  pages: { path: string; title: string }[];
  stylesheets: string[];
}

interface PageDocument {
  bundle: string;
  digest: string;
  path: string;
  title: string;
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

/** Keep the page's stylesheet links equal to the list, in its order. */
function applyStylesheets(urls: string[]): void {
  const links = [...document.head.querySelectorAll<HTMLLinkElement>("link[data-telo-stylesheet]")];
  if (links.map((link) => link.getAttribute("href")).join("\n") === urls.join("\n")) return;
  for (const link of links) link.remove();
  for (const url of urls) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.setAttribute("data-telo-stylesheet", "");
    document.head.append(link);
  }
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
      <Tooltip.Provider delayDuration={300}>
        <Application {...props} />
      </Tooltip.Provider>
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
  const base = useEnvironment(loadModule, prefix);
  const [app, setApp] = useState<AppDocument>();
  const [page, setPage] = useState<PageDocument>();
  const [failure, setFailure] = useState<ErrorSpec>();
  const [refreshes, setRefreshes] = useState(0);
  const held = useRef<{ app?: AppDocument; page?: PageDocument }>({});
  const path = host.location.path;
  const declared = app?.pages.find((candidate) => candidate.path === path);

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

  useEffect(() => {
    if (!declared) return;
    let current = true;
    const holding = held.current.page?.path === path ? held.current.page : undefined;
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
  }, [prefix, path, declared !== undefined, refreshes]);

  useEffect(() => {
    if (!app) return;
    applyStylesheets(app.stylesheets);
    document.title = declared ? `${declared.title} · ${app.title}` : app.title;
  }, [app, declared]);

  /** A plain click on an anchor into this application moves the page without
   *  leaving it. Anything else is the browser's. */
  const followAnchor = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest?.("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || href == null || anchor.getAttribute("target") || anchor.hasAttribute("download")) return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return;
    const target = url.pathname.slice(prefix.length) || "/";
    if (target === "/_telo" || target.startsWith("/_telo/")) return;
    event.preventDefault();
    host.navigate(target + url.search + url.hash);
  };

  const shown = page?.path === path ? page : undefined;
  const state = failure ? "error" : !app ? "loading" : !declared ? "empty" : shown ? "idle" : "loading";
  return (
    <HostContext.Provider value={store}>
      <RendererContext.Provider value={base}>
        <div data-telo-part="app" onClick={followAnchor}>
          <header data-telo-part="header">
            <span data-telo-part="app-title">{app?.title}</span>
            <nav data-telo-part="nav">
              {app?.pages.map((entry) => {
                const href = store.localHref(entry.path);
                return href === undefined ? (
                  <ErrorNode
                    key={entry.path}
                    error={{
                      type: "error",
                      code: "ERR_UI_NODE_INVALID",
                      message: `The page path '${entry.path}' does not resolve inside this application.`,
                    }}
                  />
                ) : (
                  <a key={entry.path} data-telo-part="nav-link" href={href} data-current={entry.path === path ? "page" : undefined} aria-current={entry.path === path ? "page" : undefined}>
                    {entry.title}
                  </a>
                );
              })}
            </nav>
          </header>
          <main data-telo-part="main">
            <div data-telo-part="page" data-state={state}>
              {failure ? (
                <ErrorNode error={failure} />
              ) : !app ? (
                <Loading />
              ) : !declared ? (
                <>
                  <h1 data-telo-part="page-title">Not found</h1>
                  <p data-telo-part="text">This application has no page at {path}.</p>
                </>
              ) : (
                <>
                  <h1 data-telo-part="page-title">{declared.title}</h1>
                  {shown ? <Nodes nodes={shown.children} /> : <Loading />}
                </>
              )}
            </div>
          </main>
        </div>
      </RendererContext.Provider>
    </HostContext.Provider>
  );
}

function useEnvironment(loadModule: AppProps["loadModule"], prefix: string): RendererEnvironment {
  return useMemo(
    () => ({ prefix, loadModule: loadModule ?? ((url: string) => import(/* @vite-ignore */ url)) }),
    [prefix, loadModule],
  );
}

/** Render the application into the shell's root element, which says where it
 *  is mounted and which renderer it was served with. */
export function mount(root: HTMLElement): Root {
  const rendered = createRoot(root);
  rendered.render(<App prefix={root.dataset.teloMount ?? ""} bundle={root.dataset.teloBundle ?? ""} />);
  return rendered;
}
