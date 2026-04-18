import { Button } from "../ui/button";

export const rowBase = "flex items-center gap-1.5 px-4 py-0.5 cursor-default select-none";
export const rowHover = "hover:bg-zinc-100 dark:hover:bg-zinc-900";
export const inputCls =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

export function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      {onAdd && (
        <Button variant="ghost" size="icon-xs" onClick={onAdd}>
          +
        </Button>
      )}
    </div>
  );
}

export function EmptyHint({ text }: { text: string }) {
  return <div className="px-4 py-1 text-xs italic text-zinc-400 dark:text-zinc-600">{text}</div>;
}

export function SectionDivider() {
  return <div className="mx-3 border-t border-zinc-100 dark:border-zinc-800" />;
}
