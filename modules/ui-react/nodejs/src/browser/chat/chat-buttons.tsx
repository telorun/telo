import { createContext, useContext } from "react";
import type { IconName } from "../../contract/ui-react-controls.js";
import { Displayed, type ButtonSpec } from "../display-button.js";

export type ButtonKey = "copy" | "edit" | "regenerate" | "attach" | "send" | "stop";

export type ChatButtons = Record<ButtonKey, ButtonSpec>;

const TEXT: ButtonSpec = { type: "text" };

export const ButtonsContext = createContext<ChatButtons>({
  copy: TEXT,
  edit: TEXT,
  regenerate: TEXT,
  attach: TEXT,
  send: TEXT,
  stop: TEXT,
});

/** The look's glyph for what each button does. */
const GLYPHS: Record<ButtonKey, IconName> = {
  copy: "copy",
  edit: "edit",
  regenerate: "regenerate",
  attach: "attach",
  send: "send",
  stop: "stop",
};

interface ChatButtonProps {
  which: ButtonKey;
  part: string;
  /** The button's text: its content, or its accessible name and tooltip when drawn as a glyph alone. */
  text: string;
  type?: "button" | "submit";
  disabled?: boolean;
  /** The press succeeded: a glyph display draws the check mark in place of its own glyph. */
  done?: boolean;
  onClick?: () => void;
}

/** One of the chat's configurable buttons, drawn as its display says: by its text, or by a glyph. */
export function ChatButton({ which, part, text, type = "button", disabled, done, onClick }: ChatButtonProps) {
  const display = useContext(ButtonsContext)[which];
  return (
    <Displayed display={display} text={text} glyph={done ? "done" : GLYPHS[which]}>
      <button data-telo-part={part} type={type} disabled={disabled} onClick={onClick} />
    </Displayed>
  );
}
