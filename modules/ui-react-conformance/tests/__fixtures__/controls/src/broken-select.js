import { createElement, useState } from "react";
import { BUILT_IN_CONTROLS } from "../../../../../ui-react/nodejs/src/browser/controls/index.ts";

const Reference = BUILT_IN_CONTROLS.Select;

// The other layer controls are the renderer's own: a set replacing one layer
// control replaces all eight.
export const { MultiSelect, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip } = BUILT_IN_CONTROLS;

// The renderer's own Select, except that Escape closes it on its own, without
// asking the renderer through `onOpenChange`.
export function Select(props) {
  const [shut, setShut] = useState(false);
  return createElement(Reference, {
    ...props,
    open: props.open && !shut,
    onOpenChange: (open, reason) => {
      if (!open && reason === "escape") return setShut(true);
      if (open) setShut(false);
      props.onOpenChange(open, reason);
    },
  });
}
