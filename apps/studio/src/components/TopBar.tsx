import { MessageSquare, Monitor, Moon, Redo2, Sun, Undo2 } from "lucide-react";
import type { ParsedManifest, Workspace } from "../model";
import { type ThemePreference, useColorModeControls } from "../theme/color-mode";
import { getModuleFiles, summarizeFiles } from "../diagnostics-aggregate";
import { DiagnosticBadge } from "./diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "./diagnostics/DiagnosticsContext";
import { Button } from "./ui/button";

/** Workspace-global chrome only. Running belongs to one Application, so its
 *  trigger, status and history live in that module's own view-tab strip — a
 *  Run button here read as global and said nothing about which app it started. */
interface TopBarProps {
  workspace: Workspace | null;
  activeManifest: ParsedManifest | null;
  /** Opens a directory picker. Absent where the environment offers no choice of
   *  workspace — there is exactly one, so an "open" action would re-open what is
   *  already open. */
  onOpen?: () => void;
  onOpenSettings: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Toggle the authoring-agent chat side panel. */
  onToggleChat?: () => void;
  chatOpen?: boolean;
}

export function TopBar({
  workspace,
  activeManifest,
  onOpen,
  onOpenSettings,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onToggleChat,
  chatOpen,
}: TopBarProps) {
  const label = activeManifest?.metadata.name ?? (workspace ? "(no module selected)" : "");
  const diagState = useDiagnosticsState();
  const topBarSummary = activeManifest
    ? summarizeFiles(diagState, getModuleFiles(activeManifest))
    : null;
  return (
    <div className="flex h-10 items-center border-b border-zinc-200 bg-white px-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <span className="font-semibold text-zinc-900 dark:text-zinc-100">Telo Studio</span>

      <div className="mx-4 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-zinc-500 dark:text-zinc-400">
        {workspace && (
          <>
            <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
            <DiagnosticBadge summary={topBarSummary} size="sm" stopPropagation={false} />
          </>
        )}
      </div>

      <div className="flex gap-2">
        {onOpen && (
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open folder…
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo"
          aria-label="Undo"
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo"
          aria-label="Redo"
        >
          <Redo2 />
        </Button>
        <Button variant="ghost" size="sm" disabled>
          Save
        </Button>
        <ThemeToggleButton />
        {onToggleChat && (
          <Button
            variant={chatOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleChat}
            title="Authoring agent"
          >
            <MessageSquare className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
      </div>
    </div>
  );
}

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const PREFERENCE_ICON: Record<ThemePreference, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** Cycles the editor's color mode: system → light → dark. */
function ThemeToggleButton() {
  const { preference, setPreference } = useColorModeControls();
  const Icon = PREFERENCE_ICON[preference];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setPreference(NEXT_PREFERENCE[preference])}
      title={`Theme: ${preference} (click to change)`}
      aria-label={`Theme: ${preference}`}
    >
      <Icon />
    </Button>
  );
}
