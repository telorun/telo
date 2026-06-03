import { X } from "lucide-react";

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

/** The unified open-editors strip above the center pane. Presentational: the
 *  caller maps module/file tabs to `TabItem`s (label + icon) and handles
 *  activation/close. */
export function EditorTabs({ items, onActivate, onClose }: EditorTabsProps) {
  if (items.length === 0) return null;
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
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
          className={`group flex max-w-[14rem] shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-200 px-3 text-xs dark:border-zinc-800 ${
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
