import "@radix-ui/themes/styles.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";
import "./app/globals.css";

import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { Editor } from "./components/Editor";
import { RunProvider, setupAdapters } from "./run";
import { AgentProvider } from "./agent";
import { migrateLegacyStorageKeys } from "./storage-key-migration";
import { ColorModeProvider, useColorMode } from "./theme/color-mode";

// Before anything reads localStorage — `ColorModeProvider` reads its key during
// the first render, and the run adapters read theirs on setup.
migrateLegacyStorageKeys();

setupAdapters();

/** Bridges the editor's color mode into Radix's appearance so its themed
 *  primitives switch alongside the Tailwind `.dark` class. */
function ThemedApp() {
  const mode = useColorMode();
  return (
    <Theme appearance={mode}>
      <RunProvider>
        <AgentProvider>
          <Editor />
        </AgentProvider>
      </RunProvider>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(
  <ColorModeProvider>
    <ThemedApp />
  </ColorModeProvider>,
);
