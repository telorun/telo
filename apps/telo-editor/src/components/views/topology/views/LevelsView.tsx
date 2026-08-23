import { useCallback, useMemo } from "react";
import {
  ApplicationTopologyCanvas,
  type InteriorAffordance,
} from "../ApplicationTopologyCanvas";
import type { GraphNode } from "../application-canvas-model";
import { childrenAt, pathKey, projectLevel } from "../containment";
import { RootLevel } from "./RootLevel";
import type { TopologyViewProps } from "../topology-view";

/**
 * One level of the containment tree at a time.
 *
 * The TOP level is a list, not a graph — `targets:` is a flat boot sequence and
 * a Library's top level is its export surface, neither of which a picture of
 * edges can carry the shape of ({@link RootLevel}). That is a property of what
 * the level IS, so it is a branch here rather than a second entry on the view
 * picker: offering a list and a graph of the same root as alternatives asked the
 * reader to choose between an ordered thing and a drawing that cannot show the
 * order, and made "drill in" mean two different things depending on which they
 * had picked.
 *
 * The level fills the canvas, which is what makes this the editing surface of
 * the nesting views: every affordance the flat overview had — the port rail,
 * drag-to-wire, edge inputs, create-and-link — is unchanged, because the level
 * is just a projection of the same model handed to the same renderer. What
 * nesting adds is which nodes are on screen.
 *
 * It stays the right view on a deep chain, where a nested-frame view runs out of
 * screen: depth costs a breadcrumb segment — the host's — rather than a nesting
 * level.
 */
export function LevelsView(props: TopologyViewProps) {
  const {
    tree,
    model,
    focusPath,
    onFocusPath,
    selectedResource,
    selection,
    viewportFor,
    onViewportChange,
    onSelectResource,
    onSelect,
    onDeleteResource,
    onWriteRef,
    onBackgroundClick,
  } = props;
  const level = useMemo(
    () => (tree && model ? projectLevel(model, tree, focusPath) : null),
    [tree, model, focusPath],
  );

  // Only the children of the focused node can be opened, so the affordance is
  // built from this level rather than from the whole tree.
  const interior = useMemo<InteriorAffordance | null>(() => {
    if (!tree) return null;
    const children = childrenAt(tree, focusPath);
    const counts = new Map<string, number>();
    const openable = new Set<string>();
    const shared = new Set<string>();
    for (const c of children) {
      // A cyclic child is on the path already: opening it would loop, so it
      // keeps its shared marker but offers no open control. A childless one has
      // no level to show — its own rail is where an entry is added, and that is
      // already on screen here.
      if (!c.cyclic && c.childCount > 0) {
        counts.set(c.id, c.childCount);
        openable.add(c.id);
      }
      if (c.shared) shared.add(c.id);
    }
    return {
      openable,
      counts,
      shared,
      onOpen: (node: GraphNode) => onFocusPath([...focusPath, node.name]),
    };
  }, [tree, focusPath, onFocusPath]);

  const viewportKey = `drill:${pathKey(focusPath)}`;
  const onViewport = useCallback(
    (vp: Parameters<typeof onViewportChange>[1]) => onViewportChange(viewportKey, vp),
    [onViewportChange, viewportKey],
  );

  if (focusPath.length === 0) return <RootLevel {...props} />;

  if (!tree || !level) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-900">
        <span className="text-sm text-zinc-400 dark:text-zinc-600">Analyzing module…</span>
      </div>
    );
  }

  return (
    <ApplicationTopologyCanvas
      model={level}
      // Remounts per level: each is laid out independently, so a stale viewport
      // from another level must not carry over.
      viewportKey={viewportKey}
      viewport={viewportFor(viewportKey)}
      onViewportChange={onViewport}
      selectedResource={selectedResource}
      selection={selection}
      onDeleteResource={onDeleteResource}
      onSelectResource={onSelectResource}
      onWriteRef={onWriteRef}
      onSelect={onSelect}
      onBackgroundClick={onBackgroundClick}
      interior={interior}
    />
  );
}
