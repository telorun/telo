import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export interface TabItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}

interface EditorTabsProps {
  items: TabItem[];
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

/**
 * The unified open-editors strip above the center pane. Presentational: the
 * caller maps module/file tabs to `TabItem`s (label + icon) and handles
 * activation/close.
 *
 * **Tabs shrink before the strip scrolls.** Every tab used to hold its natural
 * width, so the eighth open file put a scrollbar under a 32px strip and pushed
 * the rest out of reach — while most of those tabs were a short filename in a
 * box sized for a long one. They now shrink down to a floor first, which is
 * what a reader expects and what fits ~12 files in a normal pane before
 * anything moves.
 *
 * Past that floor the strip genuinely has to scroll, so it does — without the
 * native bar, which in a strip this short covers the tabs it is scrolling.
 * Hiding it is only honest if the strip stays reachable, which is what the
 * wheel handler below is for.
 */
export function EditorTabs({ items, onActivate, onClose }: EditorTabsProps) {
  const strip = useRef<HTMLDivElement | null>(null);

  /**
   * A vertical wheel scrolls the strip sideways.
   *
   * Attached here rather than as `onWheel` because React registers wheel
   * listeners as passive, where `preventDefault` does nothing: without it the
   * gesture would scroll the strip AND fall through to whatever scrolls
   * vertically behind it. A trackpad already sends `deltaX`; a mouse sends only
   * `deltaY`, and hiding the scrollbar without this would leave a mouse user no
   * way to reach an overflowed tab at all.
   */
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  if (items.length === 0) return null;
  return (
    <div
      ref={strip}
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-zinc-200 bg-zinc-50 [scrollbar-width:none] dark:border-zinc-800 dark:bg-zinc-900 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => (
        <div
          key={item.path}
          onClick={() => onActivate(item.path)}
          onAuxClick={(e) => {
            // Middle-click closes, matching VSCode.
            if (e.button === 1) {
              e.preventDefault();
              onClose(item.path);
            }
          }}
          title={item.path}
          className={`group flex min-w-[7rem] max-w-[14rem] shrink cursor-pointer items-center gap-1.5 border-r border-zinc-200 px-3 text-xs dark:border-zinc-800 ${
            item.active
              ? "bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          <span className="shrink-0 text-zinc-400">{item.icon}</span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(item.path);
            }}
            title="Close"
            className="invisible flex size-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 group-hover:visible dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
