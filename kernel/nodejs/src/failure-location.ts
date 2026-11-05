import { locateDiagnostic, writtenFailureSite, writtenRootOf, type LoadedGraph } from "@telorun/analyzer";
import {
  anchorableInputPointer,
  attachLocation,
  isInvokeError,
  type InvokeContext,
  type InvokeError,
  type InvokeErrorLocation,
  type ResourceInstance,
  type ResourceManifest,
  type RuntimeDiagnostic,
} from "@telorun/sdk";
import { declarationScopeOf } from "./declaration-scope.js";

/**
 * Where a failure leaving a dispatch was caused, and the file position that is.
 *
 * The callee names the input (`InvokeError.inputPointer`), the caller where it
 * wrote the inputs (`InvokeContext.inputsAt`); the dispatch exit joins the two
 * into the error's `location`, naming the resource that issued the dispatch. A
 * location is data; turning it into a file position needs the declaration the
 * issuing resource was created from, kept here per failure, and is answered only
 * for a declaration the load read from a file ({@link markWrittenDeclaration}) —
 * a template body's entries and a `base:` mapping's parent are derived, so they
 * are named and never positioned.
 */

/** The resource that issued a dispatch, as its dispatch exit names it. */
export interface DispatchCaller {
  readonly kind: string;
  readonly name: string;
  /** The source of the module the issuing resource belongs to. */
  readonly module?: string;
  /** The declaration the issuing resource was created from. */
  readonly declaration?: ResourceManifest;
}

/** A context that dispatches on a caller's behalf — the kernel's
 *  `EvaluationContext`, seen without importing it. */
export interface DispatchingContext {
  invoke<TInputs>(
    kind: string,
    name: string,
    inputs: TInputs,
    ctx?: InvokeContext,
    caller?: DispatchCaller,
  ): Promise<any>;
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
    caller?: DispatchCaller,
  ): Promise<any>;
}

const writtenDeclarations = new WeakSet<object>();
/** A located failure (an error, or the diagnostic a dispatch exit wrapped one
 *  in) → the declaration of the resource its location names. */
const callerDeclarations = new WeakMap<object, ResourceManifest>();

/** Mark `declaration` as one the load read from a file — the only kind a
 *  failure's location is positioned in. */
export function markWrittenDeclaration(declaration: object): void {
  writtenDeclarations.add(declaration);
}

/** The location a dispatch `caller` issued with `inputsAt` gives a failure
 *  pointing at `inputPointer` in its inputs. */
export function dispatchLocation(
  caller: DispatchCaller,
  inputsAt: string | undefined,
  inputPointer: string | undefined,
): InvokeErrorLocation {
  const pointer = inputsAt === undefined ? undefined : `${inputsAt}${inputPointer ?? ""}`;
  return {
    kind: caller.kind,
    name: caller.name,
    ...(caller.module !== undefined ? { module: caller.module } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
  };
}

/** Give `err` the location of the dispatch it is leaving, unless it carries one. */
export function locateInvokeFailure(
  err: InvokeError,
  caller: DispatchCaller | undefined,
  inputsAt: string | undefined,
): void {
  if (!caller || err.location !== undefined) return;
  attachLocation(err, dispatchLocation(caller, inputsAt, anchorableInputPointer(err)));
  if (caller.declaration) callerDeclarations.set(err, caller.declaration);
}

/**
 * The file position (1-based) of `pointer` in `declaration`, under the one rule a
 * failure's `location` follows: only a declaration the load read from a file, whose
 * written document agrees with it along the pointer. An empty pointer is the
 * declaration itself. `file` is the file the position is in.
 */
export function writtenPositionOf(
  graph: LoadedGraph,
  declaration: ResourceManifest,
  pointer: string | undefined,
): { file: string; line: number; column: number } | undefined {
  if (!writtenDeclarations.has(declaration)) return undefined;
  const target = pointer || undefined;
  let site = writtenFailureSite(graph, declaration, target, writtenParentOf);
  let path = site?.path;
  if (!site && target !== undefined) {
    // A step holding an inline `invoke:` is not the value written (the load extracted
    // the inline resource into a reference), so the step is identified by its name
    // instead, as every list entry on the way to it is.
    site = writtenFailureSite(graph, declaration, `${target}/name`, writtenParentOf);
    path = site?.path?.replace(/\.name$/, "");
    if (site && path === site.path) return undefined;
  }
  if (!site) return undefined;
  const located = locateDiagnostic(graph, {
    message: "",
    data: {
      filePath: site.filePath,
      resource: site.resource,
      ...(path !== undefined ? { path } : {}),
    },
  });
  if (!located) return undefined;
  return {
    file: located.file ?? site.filePath,
    line: located.range.start.line + 1,
    column: located.range.start.character + 1,
  };
}

/** Record whose declaration a wrapped failure's diagnostic is located in. */
export function recordCallerDeclaration(holder: object, caller: DispatchCaller): void {
  if (caller.declaration) callerDeclarations.set(holder, caller.declaration);
}

/**
 * The diagnostics `err` is reported with: those it carries, else one for itself;
 * an entry with a `location` gets the `origin` a renderer resolves to
 * `file:line:col` against `graph`, when its place is provably the written one.
 */
export function failureDiagnostics(err: unknown, graph: LoadedGraph | undefined): RuntimeDiagnostic[] {
  const carried = (err as { diagnostics?: unknown } | null)?.diagnostics;
  if (Array.isArray(carried) && carried.length > 0) {
    return (carried as RuntimeDiagnostic[]).map((d) => locatedDiagnostic(d, graph));
  }
  const own: RuntimeDiagnostic = {
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: string } | null)?.code,
  };
  if (!isInvokeError(err) || err.location === undefined) return [own];
  const location = err.location;
  const origin = originOf(err, location, graph);
  const named = origin ? { kind: location.kind, name: location.name } : namedResource(err, location);
  return [
    {
      ...own,
      kind: named.kind,
      resource: named.name,
      location,
      ...(origin ? { origin } : {}),
    },
  ];
}

function locatedDiagnostic(d: RuntimeDiagnostic, graph: LoadedGraph | undefined): RuntimeDiagnostic {
  const origin = d.location && !d.origin ? originOf(d, d.location, graph) : undefined;
  const named = d.location && !d.origin && !origin ? namedResource(d, d.location) : undefined;
  const children = d.children?.map((child) => locatedDiagnostic(child, graph));
  if (!origin && !named && !children) return d;
  return {
    ...d,
    ...(origin ? { origin } : {}),
    ...(named ? { kind: named.kind, resource: named.name } : {}),
    ...(children ? { children } : {}),
  };
}

function writtenParentOf(child: ResourceManifest, parentName: string): ResourceManifest | undefined {
  const parent = declarationScopeOf(child)?.resolveDeclaredManifest?.(parentName);
  return parent && writtenDeclarations.has(parent) ? parent : undefined;
}

/** The resource a failure is named by when no position is proven: the written
 *  root of the caller's declaration, else the caller as dispatched. */
function namedResource(holder: object, location: InvokeErrorLocation): { kind: string; name: string } {
  const declaration = callerDeclarations.get(holder);
  const root =
    declaration && writtenDeclarations.has(declaration)
      ? writtenRootOf(declaration, writtenParentOf)
      : undefined;
  return root ?? { kind: location.kind, name: location.name };
}

function originOf(
  holder: object,
  location: InvokeErrorLocation,
  graph: LoadedGraph | undefined,
): RuntimeDiagnostic["origin"] {
  const declaration = callerDeclarations.get(holder);
  if (!graph || !declaration || !writtenDeclarations.has(declaration)) return undefined;
  const site = writtenFailureSite(graph, declaration, location.pointer, writtenParentOf);
  if (!site) return undefined;
  return {
    filePath: site.filePath,
    resource: site.resource,
    ...(site.path !== undefined ? { path: site.path } : {}),
  };
}
