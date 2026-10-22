import type { ResourceContext } from "@telorun/sdk";
import type { WindowJob } from "./conformance-worker.js";

/**
 * The built entries of `ui-react` a check's window loads — the four React
 * entries and the renderer — resolved through this module's direct import of
 * `ui-react`. The host module `@telorun/ui-react` is not among them: nothing
 * the window draws imports it, and a control set may not.
 */
export async function rendererEntries(ctx: ResourceContext): Promise<WindowJob["entries"]> {
  const [react, jsxRuntime, reactDom, reactDomClient, renderer] = await Promise.all(
    ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@telorun/ui-react-renderer"].map((specifier) =>
      ctx.resolveControllerBrowserEntry(specifier),
    ),
  );
  return { react, jsxRuntime, reactDom, reactDomClient, renderer };
}
