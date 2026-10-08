import type { RequestScope } from "@telorun/http-dispatch";
import {
  canonicalTypeSchemaId,
  RuntimeError,
  type DataValidator,
  type ResourceContext,
  type RuntimeResource,
} from "@telorun/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { basename } from "node:path";
import abi from "./contract/abi.json" with { type: "json" };
import { AssetStore, entryAssets, type Asset, type AssetRef } from "./asset-store.js";
import { withUnhostedComponentsReplaced, type Hosted, type SpecNode } from "./component-abi.js";
import { DEFAULT_THEME_CSS } from "./default-theme.js";
import { holdsCurrent, servedDocument, SPEC_VERSION } from "./documents.js";
import { EventStreams } from "./event-streams.js";
import { judgedComposite, producedNode, type EvaluatedNode } from "./page-nodes.js";
import { shellHtml } from "./shell.js";
import { themeStylesheet, type ProvidedTheme } from "./theme-stylesheet.js";

interface PageConfig {
  path: string;
  title: string;
  children: unknown;
}

type ThemeEntry = { theme: unknown; when?: unknown };

export type AppResource = RuntimeResource & {
  title: string;
  lang?: string;
  theme?: unknown;
  defaultTheme?: boolean;
  stylesheets?: string[];
  compactBelow?: string;
  pages: PageConfig[];
};

interface Providing<T> {
  provide(): Promise<T>;
}

const provides = <T>(candidate: unknown): candidate is Providing<T> =>
  typeof (candidate as Providing<T> | null)?.provide === "function";

/** What a component may leave to the page: the ABI's supplied specifiers. */
const SUPPLIED: string[] = abi.specifiers;
/** The renderer imports the root API too, so the import map carries it. */
const MAPPED = [...SUPPLIED, "react-dom/client"];
/** The renderer's entry. Internal: the shell loads it by URL. */
const RENDERER = "@telorun/ui-react-renderer";
const HOST = "@telorun/ui-react";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Everything resolved once, when the application is mounted. */
interface Started {
  store: AssetStore;
  bundle: string;
  shell: string;
  /** What each placed composite provided — `null` for nothing — in the order
   *  the pages place them. */
  composites: (SpecNode | null)[];
  /** Each page's children as written, every composite's `ref` replaced by its
   *  place in `composites`. */
  pages: unknown[];
  /** The stylesheet of each theme, by instance. */
  themes: Map<unknown, string>;
  /** Stylesheets every request gets, before and after its theme's. */
  leading: string[];
  trailing: string[];
  validator: DataValidator;
}

/**
 * A page's children with each composite's `ref` replaced by its index in
 * `placed`, where the instance is appended. A page's structure and references
 * are literal — only leaf values are evaluated per request — so the numbering
 * made once holds for every request, and no instance passes through
 * evaluation.
 */
function withCompositesNumbered(node: unknown, placed: unknown[]): unknown {
  if (Array.isArray(node)) return node.map((child) => withCompositesNumbered(child, placed));
  if (node === null || typeof node !== "object") return node;
  const { type, ref, children } = node as EvaluatedNode;
  if (type === "composite" && provides(ref)) return { ...node, ref: placed.push(ref) - 1 };
  if (Array.isArray(children)) return { ...node, children: withCompositesNumbered(children, placed) };
  return node;
}

/** A mount path with one leading slash and no trailing one; `""` at the root. */
function mountPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export class UiReactApp {
  private readonly owner: string;
  private readonly streams: EventStreams;

  constructor(
    private readonly resource: AppResource,
    private readonly ctx: ResourceContext,
  ) {
    this.owner = `UiReact.App '${resource.metadata.name}'`;
    this.streams = new EventStreams(this.owner, ctx);
    const seen = new Set<string>();
    for (const [index, page] of resource.pages.entries()) {
      if (seen.has(page.path)) {
        throw new RuntimeError(
          "ERR_UI_PAGE_PATH_DUPLICATE",
          `${this.owner}: 'pages[${index}]' declares a path another page already has ('${page.path}'). Give each page a path of its own.`,
        );
      }
      seen.add(page.path);
    }
  }

  /** Mount contract. Everything lives in one encapsulated scope under the
   *  prefix, so the routes and the not-found handler that answers with the
   *  shell are this mount's alone; the scope loads before the server listens,
   *  which is when the application's composites, themes and files are resolved. */
  register(app: FastifyInstance, prefix = "", requestScope?: RequestScope<FastifyRequest>): void {
    const mount = mountPrefix(prefix);
    app.register(
      async (scope) => {
        const started = await this.start(mount);
        // A server stops by waiting for its connections, and an event stream
        // never ends on its own.
        scope.addHook("preClose", () => this.streams.closeAll());
        scope.get("/_telo/ui/app", (request, reply) => this.serveApp(started, request, reply));
        scope.get("/_telo/ui/page", (request, reply) => this.servePage(started, request, reply));
        scope.get("/_telo/ui/events", async (request, reply) => {
          reply.hijack();
          try {
            await this.streams.start(reply.raw, started.bundle);
          } catch (error) {
            // The reply is no longer the server's to answer: nothing else ends it.
            reply.raw.destroy();
            this.ctx.log.error("An event stream could not be started", {
              owner: this.owner,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
        scope.get("/_telo/ui/assets/:digest/*", (request, reply) => this.serveAsset(started, request, reply));
        scope.setNotFoundHandler((request, reply) => this.serveShell(started, mount, request, reply));
      },
      { prefix: mount === "" ? "/" : mount },
    );
  }

  private async start(mount: string): Promise<Started> {
    const store = new AssetStore();
    const urlOf = (ref: AssetRef) => `${mount}/_telo/ui/assets/${ref.digest}/${ref.name}`;

    const modules: Record<string, AssetRef> = {};
    const stylesheets: Record<string, AssetRef[]> = {};
    let hostAbi: string | undefined;
    for (const specifier of [...MAPPED, RENDERER]) {
      const entry = await this.ctx.resolveControllerBrowserEntry(specifier);
      const { module, assets } = entryAssets(entry);
      for (const asset of assets) await store.hold(asset);
      modules[specifier] = module;
      stylesheets[specifier] = assets.filter((asset) => asset.mediaType === "text/css");
      if (specifier === HOST) hostAbi = entry.abi;
    }
    const hosted: Hosted = { abis: hostAbi === undefined ? [] : [hostAbi], specifiers: SUPPLIED };

    const placed: unknown[] = [];
    const pages = this.resource.pages.map((page) => withCompositesNumbered(page.children, placed));
    const validator = this.ctx.createTypeValidator(canonicalTypeSchemaId("Ui", "SpecNode"));
    const composites: (SpecNode | null)[] = [];
    for (const instance of placed) {
      const provided = await (instance as Providing<{ node?: SpecNode; assets: Asset[] }>).provide();
      for (const asset of provided.assets) await store.hold(asset);
      if (provided.node === undefined) {
        composites.push(null);
        continue;
      }
      const hostable = withUnhostedComponentsReplaced(provided.node, hosted, (error) =>
        this.ctx.log.error("A component cannot be hosted and is shown as an error", {
          code: error.code,
          message: error.message,
        }),
      );
      // Judged here, once: a request places it as it stands.
      composites.push(
        judgedComposite(hostable, validator, (invalid, reason) =>
          this.ctx.log.error("A composite provides a node that is not valid and is shown as an error", {
            code: "ERR_UI_NODE_INVALID",
            type: String(invalid.type),
            reason,
          }),
        ),
      );
    }

    const themes = new Map<unknown, string>();
    for (const instance of this.themeEntries().map((entry) => entry.theme)) {
      if (themes.has(instance)) continue;
      const theme = await this.ctx
        .resolveRef(instance, provides<ProvidedTheme>, () => `'theme' of ${this.owner}`, "Ui.Theme")
        .provide();
      const css = themeStylesheet(theme, this.owner, (name, format, bytes) =>
        urlOf(store.addBytes(name, format.mediaType, Buffer.from(bytes))),
      );
      themes.set(instance, urlOf(store.addBytes("theme.css", "text/css", Buffer.from(css))));
    }

    const leading = stylesheets[RENDERER].map(urlOf);
    if (this.resource.defaultTheme !== false) {
      leading.push(urlOf(store.addBytes("default-theme.css", "text/css", Buffer.from(DEFAULT_THEME_CSS))));
    }
    const trailing: string[] = [];
    for (const file of this.resource.stylesheets ?? []) {
      trailing.push(urlOf(store.addBytes(basename(file), "text/css", await store.bytesOf(file))));
    }

    const bundle = modules[RENDERER].digest;
    const importMap: Record<string, string> = {};
    for (const specifier of MAPPED) importMap[specifier] = urlOf(modules[specifier]);
    Object.assign(importMap, store.sharedFileRemaps(urlOf));
    const shell = shellHtml({
      title: this.resource.title,
      lang: this.resource.lang,
      prefix: mount,
      bundle,
      rendererUrl: urlOf(modules[RENDERER]),
      importMap,
    });
    return { store, bundle, shell, composites, pages, themes, leading, trailing, validator };
  }

  private themeEntries(): ThemeEntry[] {
    const theme = this.resource.theme;
    if (theme === undefined) return [];
    return Array.isArray(theme) ? (theme as ThemeEntry[]) : [{ theme }];
  }

  private requestOf(request: FastifyRequest): Record<string, unknown> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    return { headers, ip: request.ip };
  }

  private send(request: FastifyRequest, reply: FastifyReply, document: Record<string, unknown>) {
    const served = servedDocument(document);
    reply.header("cache-control", "private, no-cache").header("etag", `"${served.digest}"`);
    if (holdsCurrent(request.headers["if-none-match"], served.digest)) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(served.text);
  }

  private serveApp(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const scope = { request: this.requestOf(request) };
    const chosen = this.themeEntries().find(
      (entry) => entry.when === undefined || this.ctx.expandValue(entry.when, scope) === true,
    );
    const theme = chosen === undefined ? [] : [started.themes.get(chosen.theme) as string];
    return this.send(request, reply, {
      specVersion: SPEC_VERSION,
      bundle: started.bundle,
      title: this.resource.title,
      ...(this.resource.lang === undefined ? {} : { lang: this.resource.lang }),
      pages: this.resource.pages.map(({ path, title }) => ({ path, title })),
      stylesheets: [...started.leading, ...theme, ...started.trailing],
      compactBelow: this.resource.compactBelow ?? "40rem",
    });
  }

  private servePage(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const path = (request.query as Record<string, unknown>).path;
    const index = this.resource.pages.findIndex((candidate) => candidate.path === path);
    const page = this.resource.pages[index];
    if (!page) {
      return reply
        .code(404)
        .header("cache-control", "private, no-cache")
        .send({ error: "NotFound", message: `This application declares no page at '${String(path)}'.`, status: 404 });
    }
    const evaluated = this.ctx.expandValue(started.pages[index], { request: this.requestOf(request) }) as EvaluatedNode[];
    const children = evaluated
      .map((node) =>
        producedNode(
          node,
          (ref) => started.composites[ref as number],
          started.validator,
          (invalid, reason) =>
            this.ctx.log.error("A page node is not valid for this request and is shown as an error", {
              code: "ERR_UI_NODE_INVALID",
              page: page.path,
              type: String(invalid.type),
              reason,
            }),
        ),
      )
      .filter((node) => node !== undefined);
    return this.send(request, reply, {
      specVersion: SPEC_VERSION,
      bundle: started.bundle,
      path: page.path,
      title: page.title,
      children,
    });
  }

  private serveAsset(started: Started, request: FastifyRequest, reply: FastifyReply) {
    const params = request.params as { digest: string; "*": string };
    const asset = started.store.get(params.digest, params["*"]);
    if (!asset) {
      return reply.code(404).send({ error: "NotFound", message: "No such asset.", status: 404 });
    }
    reply.header("cache-control", IMMUTABLE).type(asset.mediaType);
    return reply.send(asset.body);
  }

  private serveShell(started: Started, mount: string, request: FastifyRequest, reply: FastifyReply) {
    const pathname = new URL(request.url, "http://telo.invalid").pathname;
    const path = pathname.slice(mount.length) || "/";
    if (path === "/_telo" || path.startsWith("/_telo/")) {
      return reply.code(404).send({ error: "NotFound", message: `Nothing is served at '${path}'.`, status: 404 });
    }
    const declared = this.resource.pages.some((page) => page.path === path);
    return reply
      .code(declared ? 200 : 404)
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(started.shell);
  }
}

export async function create(resource: AppResource, ctx: ResourceContext): Promise<UiReactApp> {
  return new UiReactApp(resource, ctx);
}
