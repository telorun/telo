import {
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  MoreVertical,
  Redo2,
  Settings,
  Sun,
  Undo2,
} from "lucide-react";
import type { ParsedManifest, Workspace } from "../model";
import { type ThemePreference, useColorModeControls } from "../theme/color-mode";
import { getModuleFiles, summarizeFiles } from "../diagnostics-aggregate";
import { DiagnosticBadge } from "./diagnostics/DiagnosticBadge";
import { useDiagnosticsState } from "./diagnostics/DiagnosticsContext";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { TeloLanguage } from "../hooks/useLanguageSession";
import { TeloVersionControl } from "./TeloVersionControl";
import { CloudAccountControl } from "./cloud/CloudAccountControl";
import { WorkspaceSwitcher, type WorkspaceSwitcherProps } from "./WorkspaceSwitcher";

/** Workspace-global chrome only. Running belongs to one Application, so its
 *  trigger, status and history live in that module's own view-tab strip — a
 *  Run button here read as global and said nothing about which app it started. */
interface TopBarProps {
  workspace: Workspace | null;
  activeManifest: ParsedManifest | null;
  workspaceSwitcher: WorkspaceSwitcherProps;
  /** Opens the sidebar drawer; the button exists at phone width only. */
  onOpenNav?: () => void;
  onOpenSettings: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Toggle the authoring-agent chat side panel. */
  onToggleChat?: () => void;
  chatOpen?: boolean;
  /** The telo version the active module is edited against; null until the
   *  workspace's language session is up. */
  teloLanguage?: TeloLanguage | null;
}

export function TopBar({
  workspace,
  activeManifest,
  workspaceSwitcher,
  onOpenNav,
  onOpenSettings,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onToggleChat,
  chatOpen,
  teloLanguage,
}: TopBarProps) {
  const label = activeManifest?.metadata.name ?? (workspace ? "(no module selected)" : "");
  const diagState = useDiagnosticsState();
  const topBarSummary = activeManifest
    ? summarizeFiles(diagState, getModuleFiles(activeManifest))
    : null;
  // What is open below the workspace: the module and the telo it is edited
  // against. Beside the workspace menu, or on a row of its own at phone width.
  const moduleContext = (
    <>
      {workspace && (
        <>
          <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
          <DiagnosticBadge summary={topBarSummary} size="sm" stopPropagation={false} />
        </>
      )}
      {teloLanguage && <TeloVersionControl language={teloLanguage} />}
    </>
  );
  return (
    <>
    <div className="flex h-10 shrink-0 items-center border-b border-zinc-200 bg-white px-4 text-sm max-md:px-2 dark:border-zinc-800 dark:bg-zinc-950">
      {onOpenNav && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-1 md:hidden"
          onClick={onOpenNav}
          title="Files and modules"
          aria-label="Files and modules"
        >
          <Menu />
        </Button>
      )}
      <span className="shrink-0 font-semibold text-zinc-900 dark:text-zinc-100">Telo Studio</span>

      <div className="mx-3 flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-zinc-500 max-md:mx-1 dark:text-zinc-400">
        <WorkspaceSwitcher {...workspaceSwitcher} />
        <div className="flex min-w-0 items-center gap-2 max-md:hidden">{moduleContext}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <div className="flex items-center gap-1 max-md:hidden">
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
          <ThemeToggleButton />
        </div>
        <EditMenu onUndo={onUndo} onRedo={onRedo} canUndo={canUndo} canRedo={canRedo} />
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
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Settings />
        </Button>
        <CloudAccountControl />
      </div>
    </div>
    {(workspace || teloLanguage) && (
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-200 bg-white px-3 text-sm text-zinc-500 md:hidden dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        {moduleContext}
      </div>
    )}
    </>
  );
}

/** Undo, Redo and the theme, folded into one menu at phone width. */
function EditMenu({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: Pick<TopBarProps, "onUndo" | "onRedo" | "canUndo" | "canRedo">) {
  const { preference, setPreference } = useColorModeControls();
  const ThemeIcon = PREFERENCE_ICON[preference];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          title="Undo, redo and theme"
          aria-label="Undo, redo and theme"
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem disabled={!canUndo} onSelect={onUndo}>
          <Undo2 />
          Undo
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
          <Redo2 />
          Redo
        </DropdownMenuItem>
        <DropdownMenuItem
          // Stays open: the theme cycles, and one tap rarely lands on the wanted one.
          onSelect={(event) => {
            event.preventDefault();
            setPreference(NEXT_PREFERENCE[preference]);
          }}
        >
          <ThemeIcon />
          Theme: {preference}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
