import { ChevronRight } from "lucide-react";
import { focusChain, focusedId, type ContainmentTree, type NodeId } from "./containment";

/**
 * The way out of a focus path.
 *
 * Rendered by the topology HOST, not by a view: the focus is the one navigation
 * fact every view shares, and a view is now resolved for whatever node it
 * designates — so a kind's own canvas, which knows nothing about the containment
 * tree, still gets the way back that put the user inside it.
 *
 * The host renders it only below the root. There is nothing to pop at the root,
 * and the module-wide views are not all canvases — a floating chip over the boot
 * list would sit on top of its first heading to say what the tab already says.
 */
export function Breadcrumb({
  tree,
  focusPath,
  onFocusPath,
}: {
  tree: ContainmentTree;
  focusPath: NodeId[];
  onFocusPath: (path: NodeId[]) => void;
}) {
  const chain = focusChain(tree, focusPath);
  const current = focusedId(tree, focusPath);
  return (
    <div className="flex max-w-[60vw] items-center gap-0.5 rounded-md border border-zinc-200 bg-white/90 px-1.5 py-1 text-xs shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
      {chain.map((id, i) => (
        <span key={`${id}@${i}`} className="flex min-w-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="size-3 shrink-0 text-zinc-300 dark:text-zinc-600" />}
          <button
            type="button"
            className={`truncate rounded px-1 py-0.5 ${
              id === current && i === chain.length - 1
                ? "font-semibold text-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            }`}
            // Index 0 is the tree root, so its path is empty.
            onClick={() => onFocusPath(focusPath.slice(0, i))}
          >
            {id}
          </button>
        </span>
      ))}
    </div>
  );
}
