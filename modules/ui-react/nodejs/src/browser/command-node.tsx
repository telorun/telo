import { createContext, useContext, type ReactNode } from "react";
import type { IconName } from "../contract/ui-react-controls.js";
import { readBinding, styleAttribute, type Binding, type Style } from "./bindings.js";
import { Displayed, type ButtonSpec } from "./display-button.js";
import { RootsContext } from "./renderer-context.js";
import { useText, type WireText } from "./texts.js";
import { UiError } from "./ui-error.js";

/** A command as a root offers it: whether it is there at all, and whether it can run now. */
export interface Command {
  offered: boolean;
  enabled: boolean;
}

/** How a command is run, and the look's glyph for it. */
export interface CommandHandler {
  run: () => void;
  glyph: IconName;
}

/** The handlers of the commands the place drawing a tree offers, by the chain naming each (`chat.exportTranscript`). */
export const CommandsContext = createContext<Readonly<Record<string, CommandHandler>>>({});

interface CommandNodeSpec {
  command: Binding;
  text: WireText;
  button: ButtonSpec;
  style?: Style;
  fill?: boolean;
}

/**
 * A `command` node: a button running the command its binding names, drawn as
 * its display says. One not offered is not drawn; one that cannot run now is
 * disabled. A binding naming no command the place offers is refused.
 */
export function CommandNode({ node }: { node: CommandNodeSpec }): ReactNode {
  const roots = useContext(RootsContext);
  const handlers = useContext(CommandsContext);
  const text = useText();
  const binding = node.command;
  const name = "root" in binding ? [binding.root, ...binding.path].join(".") : undefined;
  const read = readBinding(binding, roots);
  const handler = name === undefined ? undefined : handlers[name];
  const command = read.present ? (read.value as Partial<Command> | null) : undefined;
  if (!handler || typeof command?.offered !== "boolean" || typeof command.enabled !== "boolean") {
    throw new UiError("ERR_UI_COMMAND_UNRESOLVED", `The 'command' node names ${name === undefined ? "a fixed value" : `'${name}'`}, which is no command this place offers.`);
  }
  if (!command.offered) return null;
  return (
    <Displayed display={node.button} text={text(node.text)} glyph={handler.glyph}>
      <button
        data-telo-part="command"
        data-command={name}
        data-button={node.button.type}
        data-fill={node.fill === true ? "true" : undefined}
        data-style={styleAttribute(node.style)}
        type="button"
        disabled={!command.enabled}
        onClick={handler.run}
      />
    </Displayed>
  );
}
