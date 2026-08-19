/**
 * Reaching the durable run a kind is executing inside.
 *
 * The parking kinds and `Durable.Value` **name nothing** — no `run:` ref, no
 * backend import. They reach the run handle ambiently off the invocation
 * context, which is what makes them backend-neutral: the same `Durable.Sleep`
 * document parks a `DurableLocal.Workflow`, a Restate workflow and a Temporal
 * workflow, because each installed its own handle on the context before
 * dispatching the body.
 *
 * The refusal is the enforcement. `telo check`'s containment walk moves the same
 * failure earlier for every path it can see, but it may under-approximate — a
 * dynamically dispatched edge degrades to this error, never to silence.
 */
import {
  InvokeError,
  durableHandleOf,
  stepPath,
  type DurableRunHandle,
  type InvokeContext,
} from "@telorun/sdk";

/** The run handle, or a diagnostic naming the resource that needed one. */
export function requireRun(
  invokeCtx: InvokeContext | undefined,
  kind: string,
  resourceName: string,
): DurableRunHandle {
  const handle = durableHandleOf(invokeCtx);
  if (!handle) {
    throw new InvokeError(
      "ERR_DURABLE_NO_RUN",
      `${kind} '${resourceName}' was invoked outside a durable run. It records against the ` +
        `run's journal and can only do that inside one — put it in the body of a workflow ` +
        `kind (one extending Durable.Run), or reach it through a step of that body.`,
      { resource: resourceName, kind },
    );
  }
  return handle;
}

/**
 * Where this resource records — the path of the step that dispatched it.
 *
 * Using the enclosing step's own path rather than a child of it is deliberate
 * for a parking kind: the step engine has already opened `step(path, …)` around
 * this dispatch, so a delivery written at that path IS the step's result, and a
 * replay returns it without the await ever being reached again. One key, no
 * reconciliation between two.
 *
 * A dispatch that carries no path is one reached outside a step body; it falls
 * back to a key under the resource's own name, which is unique among the run's
 * roots.
 */
export function recordPath(invokeCtx: InvokeContext | undefined, resourceName: string): string {
  return invokeCtx?.durablePath ?? stepPath("steps", resourceName);
}
