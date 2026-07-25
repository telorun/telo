import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";

// Dismissal is a UI preference, not workspace state — its own localStorage key
// so it survives workspace switches and never migrates with `PersistedState`.
const STORAGE_KEY = "telo-editor-preview-notice-dismissed-v1";

function loadDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // localStorage may be unavailable — show the notice.
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // localStorage may be full or unavailable — the notice stays dismissed for
    // this session only.
  }
}

/** Preview-quality warning above the canvas. Dismissible, and stays dismissed
 *  across sessions. */
export function PreviewNotice() {
  const [dismissed, setDismissed] = useState(loadDismissed);
  if (dismissed) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
      <TriangleAlert className="size-3.5 shrink-0" />
      <span>
        The Telo editor is an early preview — visual editing isn't fully supported yet and some
        changes may not apply. Use the Source tab if something looks off.
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss preview notice"
        className="ml-auto text-amber-800 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-900/40 dark:hover:text-amber-200"
        onClick={() => {
          persistDismissed();
          setDismissed(true);
        }}
      >
        <X />
      </Button>
    </div>
  );
}
