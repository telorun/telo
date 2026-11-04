import { useEffect, useRef, useState } from "react";
import { useControl } from "./effective-controls.js";
import { useSay } from "./texts.js";

/** One thing a record's menu offers, and what choosing it does. */
export interface RowMenuEntry {
  key: string;
  label: string;
  /** The entry cannot be chosen now. */
  disabled?: boolean;
  /** Said of a disabled entry: why. */
  hint?: string;
  /** Run once the menu has closed and the focus is back on its button, given that button. */
  run(button: HTMLElement): void;
}

/**
 * A record's actions folded into one menu: an icon button named by the
 * `rowActionsMenu` text opening the entries. A choice runs after the menu
 * closed, with the focus back on the button, so whatever it opens — a
 * confirmation, a form — returns the focus there.
 */
export function RowMenu({ entries }: { entries: RowMenuEntry[] }) {
  const Menu = useControl("Menu");
  const Icon = useControl("Icon");
  const say = useSay();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open || chosen === undefined) return;
    const entry = entries.find((each) => each.key === chosen);
    setChosen(undefined);
    if (!entry || !button.current) return;
    button.current.focus();
    entry.run(button.current);
  }, [open, chosen]);

  const name = say("rowActionsMenu");
  return (
    <Menu
      open={open}
      items={entries.map(({ key, label, disabled, hint }) => ({ key, label, ...(disabled ? { disabled } : {}), ...(hint !== undefined ? { hint } : {}) }))}
      onOpenChange={setOpen}
      onChange={setChosen}
    >
      <button data-telo-part="row-menu" type="button" ref={button} aria-label={name} title={name}>
        <Icon name="more" />
      </button>
    </Menu>
  );
}
