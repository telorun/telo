import { Tabs as TabsPrimitive } from "radix-ui";
import type { TabsProps } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";

/**
 * Content split under tabs, on Radix's tabs with manual activation: the arrow
 * keys, Home and End move the focus among the tabs, and Enter, Space or a
 * press chooses one. Only the chosen tab's panel is drawn.
 */
export function Tabs({ label, tabs, value, onChange, children }: TabsProps) {
  return (
    <TabsPrimitive.Root data-telo-part="tabs" value={value} onValueChange={onChange} activationMode="manual">
      <TabsPrimitive.List data-telo-part="tab-list" aria-label={label} loop>
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger key={tab.key} data-telo-part="tab" value={tab.key}>
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      <TabsPrimitive.Content data-telo-part="tab-panel" value={value}>
        {children}
      </TabsPrimitive.Content>
    </TabsPrimitive.Root>
  );
}
