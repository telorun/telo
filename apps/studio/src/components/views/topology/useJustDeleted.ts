import type { ModuleGraph } from "@telorun/analyzer";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModuleViewData } from "../../../model";
import { reconcileJustDeleted, type JustDeletedSet } from "./just-deleted";

/**
 * Wraps a resource delete so the node leaves the canvas at once. `hiddenIds`
 * are the node ids to leave out of what is drawn.
 */
export function useJustDeleted(
  moduleGraph: ModuleGraph | null,
  viewData: ModuleViewData,
  onDelete: (kind: string, name: string) => void | Promise<void>,
) {
  // A failed delete is reported here, once: every caller fires and forgets.
  const [held, setHeld] = useState<JustDeletedSet>(new Map());

  const resources = viewData.manifest.resources;
  useEffect(() => {
    if (held.size === 0 || !moduleGraph) return;
    setHeld((current) =>
      reconcileJustDeleted(current, {
        graphIds: new Set(moduleGraph.nodes.map((node) => node.id)),
        declared: (kind, name) => resources.some((r) => r.kind === kind && r.name === name),
      }),
    );
  }, [held, moduleGraph, resources]);

  const deleteResource = useCallback(
    (kind: string, name: string) => {
      const node = moduleGraph?.nodes.find((n) => n.kind === kind && n.name === name);
      const id = node?.id;
      if (id) {
        setHeld((current) =>
          new Map(current).set(id, { kind, name, gone: false, settled: false }),
        );
      }
      const release = () =>
        id &&
        setHeld((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      const settle = () =>
        id &&
        setHeld((current) => {
          const entry = current.get(id);
          return entry ? new Map(current).set(id, { ...entry, settled: true }) : current;
        });
      return Promise.resolve(onDelete(kind, name)).then(settle, (error: unknown) => {
        release();
        toast.error(`Could not delete ${name}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [moduleGraph, onDelete],
  );

  const hiddenIds = useMemo<ReadonlySet<string>>(() => new Set(held.keys()), [held]);
  return { hiddenIds, deleteResource };
}
