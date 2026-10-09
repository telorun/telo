import { Check, ChevronDown, Cloud, FolderOpen, HardDrive } from "lucide-react";
import { useState } from "react";
import { useCloud } from "../cloud/context";
import { loadWorkingCopyIndex, type WorkingCopyEntry } from "../cloud/working-copy-index";
import { pathBasename } from "../loader/paths";
import { browserWorkspaceHasFiles } from "../storage";
import { OpenCloudProjectDialog } from "./cloud/OpenCloudProjectDialog";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Which workspace is open, by the backend that holds it. */
export type OpenWorkspaceKind =
  | { kind: "cloud"; projectId: string; name: string }
  | { kind: "browser" }
  | { kind: "folder"; rootDir: string };

export interface WorkspaceSwitcherProps {
  current: OpenWorkspaceKind | null;
  /** Offer the browser workspace while it is still empty — where it is the
   *  only local workspace there is. */
  alwaysOfferBrowserWorkspace: boolean;
  onOpenBrowserWorkspace: () => void;
  /** Opens a Telo Cloud working copy already on this device. */
  onOpenWorkingCopy: (projectId: string) => void;
  /** Opens a directory picker; absent where the environment has none. */
  onOpenFolder?: () => void;
  onClose: () => void;
}

const BROWSER_WORKSPACE_LABEL = "Browser workspace";

function labelOf(current: OpenWorkspaceKind | null): string {
  if (!current) return "Open workspace";
  if (current.kind === "cloud") return current.name;
  if (current.kind === "browser") return BROWSER_WORKSPACE_LABEL;
  return pathBasename(current.rootDir) || current.rootDir;
}

/** The top bar's workspace menu: every workspace this device can open without
 *  asking anything — the browser-stored one and the Telo Cloud working copies
 *  it holds — beside the two that ask, and closing the open one. */
export function WorkspaceSwitcher({
  current,
  alwaysOfferBrowserWorkspace,
  onOpenBrowserWorkspace,
  onOpenWorkingCopy,
  onOpenFolder,
  onClose,
}: WorkspaceSwitcherProps) {
  const cloud = useCloud();
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  // Read when the menu opens: both lists live in storage other code writes.
  const [workingCopies, setWorkingCopies] = useState<WorkingCopyEntry[]>([]);
  const [browserWorkspaceStored, setBrowserWorkspaceStored] = useState(false);

  function refresh(open: boolean) {
    if (!open) return;
    setWorkingCopies(loadWorkingCopyIndex());
    setBrowserWorkspaceStored(browserWorkspaceHasFiles());
  }

  const browserCurrent = current?.kind === "browser";
  const offerBrowser = alwaysOfferBrowserWorkspace || browserWorkspaceStored || browserCurrent;
  const signedIn = cloud.session.status === "signedIn";
  const CurrentIcon =
    current?.kind === "cloud" ? Cloud : current?.kind === "browser" ? HardDrive : FolderOpen;

  return (
    <>
      <DropdownMenu onOpenChange={refresh}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" title="Switch workspace">
            <CurrentIcon />
            <span className="max-w-40 truncate max-md:hidden">{labelOf(current)}</span>
            <ChevronDown className="max-md:hidden" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
          {/* Phone width shows the trigger as an icon, so the name is said here. */}
          {current && (
            <>
              <DropdownMenuLabel className="truncate md:hidden">{labelOf(current)}</DropdownMenuLabel>
              <DropdownMenuSeparator className="md:hidden" />
            </>
          )}
          {(offerBrowser || workingCopies.length > 0) && (
            <>
              <DropdownMenuLabel>On this device</DropdownMenuLabel>
              {offerBrowser && (
                <DropdownMenuItem disabled={browserCurrent} onSelect={onOpenBrowserWorkspace}>
                  <HardDrive />
                  <span className="min-w-0 flex-1 truncate">{BROWSER_WORKSPACE_LABEL}</span>
                  {browserCurrent && <Check />}
                </DropdownMenuItem>
              )}
              {workingCopies.map((entry) => {
                const isCurrent =
                  current?.kind === "cloud" && current.projectId === entry.projectId;
                return (
                  <DropdownMenuItem
                    key={entry.projectId}
                    disabled={isCurrent}
                    onSelect={() => onOpenWorkingCopy(entry.projectId)}
                  >
                    <Cloud />
                    <span className="min-w-0 flex-1 truncate">{entry.projectName}</span>
                    {isCurrent && <Check />}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </>
          )}
          {onOpenFolder && (
            <DropdownMenuItem onSelect={onOpenFolder}>Open folder…</DropdownMenuItem>
          )}
          {signedIn && (
            <DropdownMenuItem onSelect={() => setCloudDialogOpen(true)}>
              Open from Telo Cloud…
            </DropdownMenuItem>
          )}
          {current && (
            <>
              {(onOpenFolder || signedIn) && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={onClose}>Close workspace</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <OpenCloudProjectDialog open={cloudDialogOpen} onOpenChange={setCloudDialogOpen} />
    </>
  );
}
