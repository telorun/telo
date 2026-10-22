import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { readBinding, styleAttribute, type Binding } from "./bindings.js";
import { ResponseWatchContext, useHost, type ResponseWatcher } from "./host.js";
import { Node, type SpecNode } from "./nodes.js";
import { queryRoot } from "./query-root.js";
import { RendererContext, RootsContext, underMount, VisibleContext } from "./renderer-context.js";
import { requestErrorOf, unansweredError, type RequestError } from "./ui-error.js";
import { findingText, useSay, type Say } from "./texts.js";
import { validate, type JsonSchema } from "./validation.js";

type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: RequestError };

/** The record contract's read: one `GET`, answered by a 2xx JSON object valid
 *  against the model; anything else is a failure. */
async function read(fetch: (url: string) => Promise<Response>, url: string, schema: JsonSchema, say: Say): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { ok: false, error: unansweredError(error, say) };
  }
  let body: unknown;
  let parsed = true;
  try {
    body = await response.json();
  } catch {
    // Not JSON: a failure keeps its status, a success is refused below.
    parsed = false;
  }
  if (!response.ok) return { ok: false, error: requestErrorOf(response.status, body, say) };
  const invalid = (message: string): Outcome => ({ ok: false, error: { status: response.status, code: "ERR_UI_RESPONSE_INVALID", message } });
  if (!parsed) return invalid(say("answerNotJson"));
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid(say("answerNotObject"));
  const findings = validate(schema, body);
  if (findings.length > 0) return invalid(say("answerNotModel", { detail: findingText(findings[0], say) }));
  return { ok: true, data: body as Record<string, unknown> };
}

/** The address a read asks, with each parameter that holds a value. */
function addressOf(prefix: string, path: string, params: Record<string, Binding>, roots: Readonly<Record<string, unknown>>): string {
  const search = new URLSearchParams();
  for (const [name, binding] of Object.entries(params)) {
    const value = readBinding(binding, roots);
    if (value.present && ["string", "number", "boolean"].includes(typeof value.value)) search.set(name, String(value.value));
  }
  const query = search.toString();
  return `${underMount(prefix, path)}${query ? `?${query}` : ""}`;
}

/**
 * Data read when it is drawn. At most one read is in flight; any number of
 * triggers during it cause exactly one more read after it, and an answer to an
 * address the reader no longer reads is never drawn. `loading` is drawn only
 * before the first answer; a reload keeps the content mounted. Hidden, the
 * reader reads nothing, and reads once when it is shown if anything asked.
 */
export function DataNode({ node }: { node: SpecNode }) {
  const host = useHost();
  const say = useSay();
  const { prefix } = useContext(RendererContext);
  const outer = useContext(RootsContext);
  const visible = useContext(VisibleContext);
  const watchers = useContext(ResponseWatchContext);
  const query = useMemo(() => queryRoot(node.query as Record<string, JsonSchema>, host.location.search), [node.query, host.location.search]);
  const scope = useMemo(() => ({ ...outer, query }), [outer, query]);
  const address = addressOf(prefix, node.source.path as string, (node.source.params ?? {}) as Record<string, Binding>, scope);
  const reloadOn = node.reloadOn as string[];
  const [outcome, setOutcome] = useState<Outcome>();
  const [data, setData] = useState<Record<string, unknown>>();

  const state = useRef({ inFlight: false, again: false, wanted: false, visible, address, fetch: host.fetch });
  state.current.visible = visible;
  state.current.address = address;
  state.current.fetch = host.fetch;

  const request = useRef(() => {});
  request.current = () => {
    const current = state.current;
    if (!current.visible) {
      current.wanted = true;
      return;
    }
    if (current.inFlight) {
      current.again = true;
      return;
    }
    current.inFlight = true;
    current.wanted = false;
    const asked = current.address;
    void read((url) => current.fetch(url, { headers: { accept: "application/json" } }), asked, node.schema as JsonSchema, say).then((answer) => {
      current.inFlight = false;
      if (asked === current.address) {
        setOutcome(answer);
        if (answer.ok) setData(answer.data);
      } else current.again = true;
      if (current.again) {
        current.again = false;
        request.current();
      }
    });
  };

  // The first read, and another whenever the address changes.
  useEffect(() => request.current(), [address]);
  // A trigger that arrived while hidden is read once on show.
  useEffect(() => {
    if (visible && state.current.wanted) request.current();
  }, [visible]);
  useEffect(() => host.onChanged(node.source.path as string, () => request.current()), [node.source.path]);
  useEffect(() => {
    if (!reloadOn.includes("focus")) return;
    const onFocus = () => request.current();
    const onShow = (event: PageTransitionEvent) => event.persisted && request.current();
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onShow);
    };
  }, [reloadOn.includes("focus")]);

  const unauthorized = reloadOn.includes("unauthorized");
  const inside = useMemo<readonly ResponseWatcher[]>(
    () => (unauthorized ? [(response: Response) => response.status === 401 && request.current(), ...watchers] : watchers),
    [unauthorized, watchers],
  );
  const contentRoots = useMemo(() => ({ ...scope, data }), [scope, data]);
  const failed = outcome !== undefined && !outcome.ok;
  const status = failed ? "error" : data === undefined ? "loading" : "idle";

  return (
    <div data-telo-part="data" data-state={status} data-style={styleAttribute(node.style)}>
      {data !== undefined && (
        <div style={{ display: failed ? "none" : "contents" }}>
          <VisibleContext.Provider value={visible && !failed}>
            <ResponseWatchContext.Provider value={inside}>
              <RootsContext.Provider value={contentRoots}>
                <Node node={node.content} />
              </RootsContext.Provider>
            </ResponseWatchContext.Provider>
          </VisibleContext.Provider>
        </div>
      )}
      {status === "loading" && (
        <RootsContext.Provider value={scope}>
          <Node node={node.loading} />
        </RootsContext.Provider>
      )}
      {failed && (
        <RootsContext.Provider value={{ ...scope, error: outcome.error }}>
          <Node node={node.failure} />
        </RootsContext.Provider>
      )}
    </div>
  );
}
