import { useId, useRef, type KeyboardEvent } from "react";
import type { TabsProps } from "../../contract/ui-react-controls.js";

/**
 * Content split under tabs, in the tabs pattern with manual activation: the
 * arrow keys, Home and End move the focus among the tabs, and Enter, Space or
 * a press chooses one. Only the chosen tab's panel is drawn.
 */
export function Tabs({ label, tabs, value, onChange, children }: TabsProps) {
  const base = useId();
  const list = useRef<HTMLDivElement | null>(null);
  const chosen = tabs.findIndex((tab) => tab.key === value);
  // One tab is reached by Tab: the chosen one, else the first.
  const stop = chosen === -1 ? 0 : chosen;
  const tabId = (index: number) => `${base}-tab-${index}`;
  const panelId = `${base}-panel`;
  const move = (event: KeyboardEvent) => {
    const own = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = own.indexOf(event.target as HTMLElement);
    if (at === -1) return;
    const backwards = (document.documentElement.dir === "rtl") !== (event.key === "ArrowLeft");
    const to =
      event.key === "Home" ? 0
      : event.key === "End" ? own.length - 1
      : event.key === "ArrowLeft" || event.key === "ArrowRight" ? (at + (backwards ? -1 : 1) + own.length) % own.length
      : -1;
    if (to === -1) return;
    event.preventDefault();
    own[to].focus();
  };
  return (
    <div data-telo-part="tabs">
      <div data-telo-part="tab-list" role="tablist" aria-label={label} ref={list} onKeyDown={move}>
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            data-telo-part="tab"
            role="tab"
            id={tabId(index)}
            aria-selected={index === chosen}
            aria-controls={index === chosen ? panelId : undefined}
            tabIndex={index === stop ? 0 : -1}
            data-state={index === chosen ? "active" : "inactive"}
            onClick={() => index !== chosen && onChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div data-telo-part="tab-panel" role="tabpanel" id={panelId} aria-labelledby={chosen === -1 ? undefined : tabId(chosen)} tabIndex={0} data-state="active">
        {children}
      </div>
    </div>
  );
}
