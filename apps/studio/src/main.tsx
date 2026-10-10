import "@radix-ui/themes/styles.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";
import "./app/globals.css";

import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { Toaster } from "./components/ui/sonner";
import { Editor } from "./components/Editor";
import { RegionErrorBoundary } from "./components/RegionErrorBoundary";
import { RunProvider, setupAdapters } from "./run";
import { AgentProvider } from "./agent";
import { CloudProvider } from "./cloud/context";
import { installExternalLinkHandler } from "./external-link";
import { migrateLegacyStorageKeys } from "./storage-key-migration";
import { ColorModeProvider, useColorMode } from "./theme/color-mode";

// Before anything reads localStorage — `ColorModeProvider` reads its key during
// the first render, and the run adapters read theirs on setup.
migrateLegacyStorageKeys();

setupAdapters();

// Before the first render, so no link can be clicked ahead of its handler. A
// no-op outside Tauri, where anchors already open on their own.
installExternalLinkHandler();

/** Bridges the editor's color mode into Radix's appearance so its themed
 *  primitives switch alongside the Tailwind `.dark` class. */
function ThemedApp() {
  const mode = useColorMode();
  return (
    <Theme appearance={mode}>
      <RunProvider>
        <AgentProvider>
          <CloudProvider>
            <Editor />
          </CloudProvider>
        </AgentProvider>
      </RunProvider>
      {/* Mounted beside the app, not inside it: `toast()` is called from
          contexts (the run provider) that render no UI of their own. */}
      <Toaster position="bottom-right" />
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  // Outermost, so a failure no region contained still leaves a page that says
  // what happened instead of a blank one.
  <RegionErrorBoundary region="editor" className="h-screen">
    <ColorModeProvider>
      <ThemedApp />
    </ColorModeProvider>
  </RegionErrorBoundary>,
);
