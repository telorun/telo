import { Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

/** One titled block of the module bar — a heading, its add affordance, and its
 *  rows, or "None" when it has none. */
export function Section({
  title,
  onAdd,
  addMenu,
  addTitle,
  action,
  children,
}: {
  title: string;
  onAdd?: () => void;
  /** Pick-from-existing alternative to `onAdd`, for a list whose entries name
   *  something the module already declares. */
  addMenu?: { name: string; onSelect: () => void }[];
  addTitle: string;
  /** One block-wide action beside the add button — something that acts on every
   *  row at once, which no row can offer for itself. */
  action?: { icon: React.ReactNode; title: string; onClick: () => void; disabled?: boolean };
  children: React.ReactNode;
}) {
  // Falsy entries are conditionals that rendered nothing (a notice with nothing
  // to report), not content — counting them would suppress the "None" a genuinely
  // empty block owes the reader.
  const empty = Array.isArray(children)
    ? children.flat().filter(Boolean).length === 0
    : !children;
  return (
    <div className="border-t border-zinc-100 px-2 py-1.5 dark:border-zinc-900">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          {title}
        </span>
        <span className="flex items-center gap-1">
        {action && (
          <button
            className="text-amber-600 hover:text-amber-700 disabled:opacity-50 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
          >
            {action.icon}
          </button>
        )}
        {addMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title={addTitle}>
                <Plus className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
              {addMenu.map((item) => (
                <DropdownMenuItem key={item.name} className="text-xs" onSelect={item.onSelect}>
                  {item.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onAdd ? (
          <button
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            onClick={onAdd}
            title={addTitle}
          >
            <Plus className="size-3.5" />
          </button>
        ) : null}
        </span>
      </div>
      {empty ? (
        <span className="text-[11px] text-zinc-300 dark:text-zinc-600">None</span>
      ) : (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </div>
  );
}
