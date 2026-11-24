import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { changeKey, resolveRequest, type AddressWire } from "./address-wire.js";
import { fillAttribute, styleAttribute } from "./bindings.js";
import { resolveBody, type BodyTemplate } from "./body-template.js";
import { ResponseWatchContext, useHost, useHostStore, type ResponseWatcher } from "./host.js";
import { Nodes, type SpecNode } from "./nodes.js";
import { queryRoot } from "./query-root.js";
import { QueryReads, type Holder, type QueryRequest, type QueryTerms, type ReadState } from "./query-reads.js";
import { QueryAddressContext, RendererContext, RootsContext, underMount, VisibleContext } from "./renderer-context.js";
import { useSay } from "./texts.js";
import type { RequestError } from "./ui-error.js";
import type { JsonSchema } from "./validation.js";

/** A query as the page document carries it, every member present (`reloadEvery` when set). */
interface QuerySpec {
  id: string;
  schema: JsonSchema;
  method: "GET" | "QUERY" | "POST";
  url: AddressWire;
  input: { body: BodyTemplate } | null;
  query: Record<string, JsonSchema>;
  reloadOn: string[];
  reloadEvery?: number;
}

/**
 * One query's answer drawn: `content` once an answer is in, `loading` before
 * the node's first, `failure` when the read does not succeed — laid out as a
 * box lays out its children. Every node naming the same query and resolving to
 * the same request draws from one read; a node whose request changes keeps
 * drawing its last answer until the new one is in. A failed read keeps the
 * content out of sight, but a failed tick of `reloadEvery` keeps it drawn, the
 * failure beside it.
 */
export function QueryNode({ node }: { node: SpecNode }) {
  const reads = useHostStore().queries;
  const host = useHost();
  const say = useSay();
  const { prefix } = useContext(RendererContext);
  const outer = useContext(RootsContext);
  const visible = useContext(VisibleContext);
  const watchers = useContext(ResponseWatchContext);
  const spec = node.query as QuerySpec;
  const query = useMemo(() => queryRoot(spec.query, host.location.search), [spec.query, host.location.search]);
  const scope = useMemo(() => ({ ...outer, query }), [outer, query]);
  const resolved = useMemo(() => resolveRequest(spec.url, scope, `query '${spec.id}' url`), [spec.url, scope]);
  const request = useMemo<QueryRequest | undefined>(() => {
    if (!resolved.ok) return undefined;
    const body = spec.input === null ? undefined : resolveBody(spec.input.body, scope);
    return {
      method: spec.method,
      url: underMount(prefix, resolved.address),
      changeAt: changeKey(resolved.address),
      ...(body?.present ? { body: { value: body.value } } : {}),
    };
  }, [resolved, spec, scope, prefix]);
  const key = request === undefined ? undefined : QueryReads.keyOf(spec.id, request);

  const current = useRef(key);
  current.current = key;
  const holder = useRef<Holder>(undefined as unknown as Holder);
  holder.current ??= {
    visible,
    watchers,
    say,
    own: (response) => {
      if (response.status === 401 && current.current !== undefined) reads.trigger(current.current);
    },
  };
  Object.assign(holder.current, { visible, watchers, say });

  const terms: QueryTerms = { id: spec.id, schema: spec.schema, reloadOn: spec.reloadOn, ...(spec.reloadEvery === undefined ? {} : { reloadEvery: spec.reloadEvery }) };
  useEffect(() => (key === undefined || request === undefined ? undefined : reads.hold(key, terms, request, holder.current)), [key]);
  useEffect(() => reads.shown(holder.current), [visible]);

  const subscribe = useCallback((listener: () => void) => (key === undefined ? () => {} : reads.subscribe(key, listener)), [key]);
  const state = useSyncExternalStore(subscribe, () => (key === undefined ? undefined : reads.state(key)));
  const last = useRef<ReadState>(undefined);
  // The address the drawn answer was read at: it moves with the answer, not with the request.
  const answeredAt = useRef<string>(undefined);
  if (state?.outcome !== undefined) {
    last.current = state;
    answeredAt.current = request?.url;
  }
  const drawn = state?.outcome !== undefined ? state : last.current;

  const unauthorized = spec.reloadOn.includes("unauthorized");
  const inside = useMemo<readonly ResponseWatcher[]>(() => (unauthorized ? [holder.current.own, ...watchers] : watchers), [unauthorized, watchers]);
  const data = drawn?.data;
  const contentRoots = useMemo(() => ({ ...scope, data }), [scope, data]);
  // An address that does not resolve sends nothing and draws the failure.
  const failure: RequestError | undefined = !resolved.ok
    ? { code: resolved.error.code, message: resolved.error.message }
    : drawn?.outcome !== undefined && !drawn.outcome.ok
      ? drawn.outcome.error
      : undefined;
  const failed = failure !== undefined;
  // A failed tick leaves what was read on show, the failure beside it.
  const hidden = failed && !(drawn?.outcome?.tick === true && resolved.ok);
  const status = failed ? "error" : data === undefined ? "loading" : "idle";

  return (
    <div data-telo-part="query" data-state={status} data-fill={fillAttribute(node)} data-style={styleAttribute(node.style)}>
      <ResponseWatchContext.Provider value={inside}>
        {data !== undefined && (
          <div style={{ display: hidden ? "none" : "contents" }}>
            <VisibleContext.Provider value={visible && !hidden}>
              <RootsContext.Provider value={contentRoots}>
                <QueryAddressContext.Provider value={answeredAt.current}>
                  <Nodes nodes={node.content} />
                </QueryAddressContext.Provider>
              </RootsContext.Provider>
            </VisibleContext.Provider>
          </div>
        )}
        {status === "loading" && (
          <RootsContext.Provider value={scope}>
            <Nodes nodes={node.loading} />
          </RootsContext.Provider>
        )}
        {failed && (
          <RootsContext.Provider value={{ ...scope, error: failure }}>
            <Nodes nodes={node.failure} />
          </RootsContext.Provider>
        )}
      </ResponseWatchContext.Provider>
    </div>
  );
}
