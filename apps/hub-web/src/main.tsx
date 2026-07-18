import "./app/globals.css";

import { createRoot } from "react-dom/client";
import { App } from "./App";

// Follow the OS colour scheme — the SPA has no theme toggle of its own.
if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}

createRoot(document.getElementById("root")!).render(<App />);
