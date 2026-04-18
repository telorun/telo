import "@radix-ui/themes/styles.css";
import "react-complex-tree/lib/style-modern.css";
import "./app/globals.css";

import { Theme } from "@radix-ui/themes";
import { createRoot } from "react-dom/client";
import { Editor } from "./components/Editor";
import { RunProvider, setupAdapters } from "./run";

setupAdapters();

createRoot(document.getElementById("root")!).render(
  <Theme>
    <RunProvider>
      <Editor />
    </RunProvider>
  </Theme>,
);
