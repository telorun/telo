import { useMemo, useState, type MouseEventHandler, type ReactNode } from "react";
import { useAside, type AsideSpec } from "./aside.js";
import { useHost } from "./host.js";
import { Nodes, type SpecNode } from "./nodes.js";
import { PressQueueContext, PressQueues } from "./operation.js";
import { queryRoot } from "./query-root.js";
import { BottomSlotContext, RootsContext } from "./renderer-context.js";

/** The layout document: the chrome of every page that names its id. */
export interface LayoutDocument {
  bundle: string;
  digest: string;
  id: string;
  /** How wide the header's and the footer's content is inset. */
  width: "contained" | "full";
  header: SpecNode[];
  aside?: AsideSpec;
  footer: SpecNode[];
}

/**
 * The application's frame: the layout's header, aside and footer as landmarks
 * around `main`, which holds the page. Without a layout it is `main` alone.
 * The header and footer span the application, their content inset by the
 * layout's width, whatever width the page declares.
 */
export function LayoutFrame(props: {
  layout: LayoutDocument | undefined;
  compact: boolean;
  fill: "true" | undefined;
  onClick: MouseEventHandler;
  children: ReactNode;
}): ReactNode {
  const { layout, compact, fill, onClick, children } = props;
  const host = useHost();
  const aside = useAside(layout?.aside);
  const [bottom, setBottom] = useState<HTMLElement | null>(null);
  // The regions bind no page variables: one layout is drawn on pages with different ones.
  const roots = useMemo(() => ({ query: queryRoot(undefined, host.location.search), params: {} }), [host.location.search]);
  const queues = useMemo(() => new PressQueues(), []);
  const folded = aside?.state === "compact";
  const header = layout !== undefined && layout.header.length > 0;
  const footer = layout !== undefined && layout.footer.length > 0;
  const rail = folded ? aside?.rail : null;
  const side = aside?.side;
  return (
    <div data-telo-part="app" data-compact={compact ? "true" : undefined} data-fill={fill} data-side={aside !== undefined && !folded ? side : undefined} onClick={onClick}>
      <BottomSlotContext.Provider value={bottom}>
        <RootsContext.Provider value={roots}>
          <PressQueueContext.Provider value={queues}>
            {header && (
              <header data-telo-part="header" data-width={layout.width}>
                <div data-telo-part="header-content">
                  {side !== "end" && rail}
                  <Nodes nodes={layout.header} />
                  {side === "end" && rail}
                </div>
              </header>
            )}
            {side !== "end" && aside?.place("aside")}
            {!header && rail}
            {aside?.mounted}
          </PressQueueContext.Provider>
        </RootsContext.Provider>
        {children}
        <RootsContext.Provider value={roots}>
          <PressQueueContext.Provider value={queues}>
            {side === "end" && aside?.place("aside")}
            {footer && (
              <footer data-telo-part="footer" data-width={layout.width}>
                <div data-telo-part="footer-content">
                  <Nodes nodes={layout.footer} />
                </div>
              </footer>
            )}
          </PressQueueContext.Provider>
        </RootsContext.Provider>
        <div ref={setBottom} style={{ display: "contents" }} />
      </BottomSlotContext.Provider>
    </div>
  );
}
