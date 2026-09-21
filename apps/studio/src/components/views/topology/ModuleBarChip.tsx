import { Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ParsedResource, Selection } from "../../../model";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import type { DeclarationChip } from "./module-declarations";

/** Whether a chip is the entry the detail panel currently has open. */
export function isSelected(
  selection: Selection | null,
  root: ParsedResource,
  pointer: string,
): boolean {
  return (
    selection?.resource.kind === root.kind &&
    selection?.resource.name === root.name &&
    selection?.pointer === pointer
  );
}

/** One button in a row's hover cluster. */
export interface ChipAction {
  key: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  tone?: "default" | "alert" | "danger";
}

/** Shared chrome for a cluster button. Sized as a real hit target rather than a
 *  bare glyph: these sit at the edge of a 224px rail, and a 12px icon with no
 *  padding is both hard to see and hard to hit. */
const ACTION_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded transition-colors";

const ACTION_TONE: Record<NonNullable<ChipAction["tone"]>, string> = {
  default:
    "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100",
  alert:
    "text-amber-600 hover:bg-amber-100 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-950 dark:hover:text-amber-300",
  danger:
    "text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-950 dark:hover:text-red-400",
};

/** A row's own actions, offered as a menu beside it rather than as a section
 *  button: what it lists belongs to THIS entry, not to the block. A row may
 *  carry several — creating from an import's kinds and choosing its version are
 *  two different questions about the same row. */
export interface ChipMenu {
  key: string;
  title: string;
  icon: React.ReactNode;
  /** Heading above the items, for a menu whose entries are values rather than
   *  actions (a version list). */
  label?: string;
  /** Fired when the menu opens, for a list that is fetched on demand. */
  onOpenChange?: (open: boolean) => void;
  items: ChipMenuItem[];
}

export interface ChipMenuItem {
  key: string;
  label: string;
  /** Secondary text, right-aligned and quiet — a kind's capability. */
  detail?: string;
  /** Status of THIS entry (`current`, `needs newer telo`), which is a different
   *  thing from `detail` and is allowed to shout. */
  note?: string;
  noteTone?: "muted" | "warn";
  title?: string;
  /** A row that reports rather than offers: loading, an error, or the reason a
   *  list is empty. Rendered as unselectable prose. */
  message?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export function Chip({
  chip,
  active,
  onOpen,
  openTitle,
  onRename,
  onRemove,
  menus,
  actions,
  alert,
  badge,
}: {
  chip: DeclarationChip;
  active?: boolean;
  onOpen?: () => void;
  openTitle?: string;
  /** Editing the KEY. Separate from the panel's form, which edits the entry's
   *  fields: the key is the entry's identity and the form's own pointer, so it
   *  cannot be one of the fields the form rewrites. */
  onRename?: { validate: (next: string) => string | undefined; commit: (next: string) => void };
  onRemove?: () => void;
  menus?: ChipMenu[];
  /** Extra affordances in the cluster — things the row can do that are neither
   *  opening its entry nor editing its key. */
  actions?: ChipAction[];
  /** A short classifier rendered beside the name — one word about what the row
   *  IS, as opposed to `chip.detail`, which is a second line of its value. */
  badge?: string;
  /** Holds the cluster open. For a row whose actions are not merely available
   *  but WANTED — an outdated import — where hiding them behind hover would
   *  leave the call to action on a rail nobody thinks to hover. */
  alert?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const error = draft === null ? undefined : onRename?.validate(draft);

  if (draft !== null && onRename) {
    return (
      <RenameInput
        draft={draft}
        error={error}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onCommit={() => {
          if (error) return;
          if (draft !== chip.name) onRename.commit(draft);
          setDraft(null);
        }}
      />
    );
  }

  const startRename = onRename ? () => setDraft(chip.name) : undefined;

  return (
    // The row carries the background, not the label — which is what lets the
    // action cluster float over its right edge on a solid lane instead of
    // standing in the flow. Sitting in the flow, those buttons held their width
    // permanently for affordances that are invisible until hover: ~32px of a
    // 208px row, so every label truncated that much earlier, always. Removing
    // them from the flow instead (`hidden`/`flex`) would reflow and re-truncate
    // the label the instant the pointer arrives, which is worse than the gap.
    <div
      className={`group relative flex items-center rounded ${
        active
          ? "bg-indigo-50 dark:bg-indigo-950"
          : onOpen
            ? "hover:bg-zinc-100 dark:hover:bg-zinc-900"
            : ""
      }`}
      // F2 on the focused row, the shortcut every file explorer uses. Bound on
      // the row rather than the label so it fires wherever focus sits within
      // the chip — the label, the pencil, the remove button.
      onKeyDown={(e) => {
        if (e.key !== "F2" || !startRename) return;
        e.preventDefault();
        startRename();
      }}
    >
      <button
        className="min-w-0 flex-1 select-none px-1.5 py-0.5 text-left"
        onClick={onOpen}
        // Double-click renames, the other half of the same convention. The
        // single click that precedes it has already opened the entry, which is
        // what you want open behind a rename anyway.
        onDoubleClick={startRename}
        // Renaming needs the row focusable even where opening it does nothing,
        // so the button stays enabled and the click handler is simply absent.
        title={openTitle ?? chip.detail ?? chip.name}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-200">
            {chip.name}
          </span>
          {badge && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {badge}
            </span>
          )}
        </span>
        {chip.detail && (
          <span className="block truncate font-mono text-[9px] text-zinc-400">{chip.detail}</span>
        )}
      </button>
      {/* `bg-inherit` takes the row's own background, so the cluster is only
          ever painted over a solid colour — it is revealed by hover and by
          focus, which are exactly the states in which the row has one.
          `pointer-coarse` has no hover at all, so there it stays visible. */}
      <div
        className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r bg-inherit pl-3 pr-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100 ${
          alert ? "opacity-100" : "opacity-0"
        }`}
      >
        {(menus ?? []).map((menu) => (
          <DropdownMenu key={menu.key} onOpenChange={menu.onOpenChange}>
            <DropdownMenuTrigger asChild>
              <button className={`${ACTION_CLASS} ${ACTION_TONE.default}`} title={menu.title}>
                {menu.icon}
              </button>
            </DropdownMenuTrigger>
            {/* Beside the row, not below it: the rail is narrow and a list of
                kinds — or of versions — is wider than it. */}
            <DropdownMenuContent
              side="right"
              align="start"
              // Sized to its own content: the shared default matches the trigger's
              // width, and this trigger is one icon.
              className="max-h-72 w-auto min-w-44 overflow-y-auto"
            >
              {menu.label && <DropdownMenuLabel>{menu.label}</DropdownMenuLabel>}
              {menu.items.map((item) => (
                <DropdownMenuItem
                  key={item.key}
                  className={
                    item.message
                      ? "whitespace-normal text-[11px] leading-snug"
                      : "justify-between gap-3 text-xs"
                  }
                  disabled={item.disabled ?? item.message}
                  title={item.title}
                  onSelect={item.onSelect}
                >
                  <span className={item.message ? undefined : "flex-1"}>{item.label}</span>
                  {item.detail && (
                    <span className="ml-3 text-[9px] uppercase tracking-wide text-zinc-400">
                      {item.detail}
                    </span>
                  )}
                  {item.note && (
                    <span
                      className={`ml-3 text-[10px] ${
                        item.noteTone === "warn"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {item.note}
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        {(actions ?? []).map((item) => (
          <button
            key={item.key}
            className={`${ACTION_CLASS} ${ACTION_TONE[item.tone ?? "default"]}`}
            onClick={item.onClick}
            title={item.title}
          >
            {item.icon}
          </button>
        ))}
        {onRename && (
          <button
            className={`${ACTION_CLASS} ${ACTION_TONE.default}`}
            onClick={() => setDraft(chip.name)}
            title={`Rename ${chip.name}`}
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        {onRemove && (
          <button
            className={`${ACTION_CLASS} ${ACTION_TONE.danger}`}
            onClick={onRemove}
            title={`Remove ${chip.name}`}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** The key, in place. Enter commits, Escape abandons, and losing focus commits
 *  too — a rename left half-typed and clicked away from is far likelier to be
 *  finished than abandoned. A rejected name never commits: the input stays open
 *  with the reason, since the alternative is writing a name `telo check` refuses
 *  or silently overwriting the entry it collides with. */
function RenameInput({
  draft,
  error,
  onChange,
  onCancel,
  onCommit,
}: {
  draft: string;
  error?: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <div className="flex flex-col gap-0.5 px-1.5 py-0.5">
      <input
        ref={ref}
        className={`w-full rounded border bg-white px-1 py-0.5 text-xs outline-none dark:bg-zinc-900 ${
          error
            ? "border-red-400 text-red-600 dark:text-red-400"
            : "border-indigo-400 text-zinc-800 dark:text-zinc-100"
        }`}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (error ? onCancel() : onCommit())}
      />
      {error && <span className="text-[9px] leading-tight text-red-500">{error}</span>}
    </div>
  );
}
