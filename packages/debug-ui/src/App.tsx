import { DebugWatcher } from "./components/DebugWatcher.js";

/**
 * Standalone debug-watcher page. Served by a Telo runtime's debug server at `/`,
 * so the SSE endpoint is `/events` on the same origin — no configuration needed.
 */
export function App() {
  const url = new URL("events", window.location.href).toString();
  return <DebugWatcher url={url} />;
}
