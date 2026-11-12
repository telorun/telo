import { useContext, type ReactNode } from "react";
import { styleAttribute, type Style } from "./bindings.js";
import { Displayed, type ButtonSpec } from "./display-button.js";
import type { RowActionSpec } from "./operation.js";
import { RootsContext } from "./renderer-context.js";
import { useRowActions } from "./row-actions.js";

/** A `button` node: a bound action, and how its button is drawn. */
export interface ButtonNodeSpec extends RowActionSpec {
  button: ButtonSpec;
  style?: Style;
  fill?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A `button` node: its action run with the inputs it binds over the roots in
 * scope, labelled with the action's label and drawn as its display says. It is
 * drawn as a row action is — the action's answer in place of the button, its
 * failure beside it or in the open confirmation, no press while one is pending.
 */
export function ButtonNode({ node }: { node: ButtonNodeSpec }): ReactNode {
  const roots = useContext(RootsContext);
  const actions = useRowActions([node], roots, () => {});
  // A button inside a record reads that record as `row`, as its other roots.
  const row = isRecord(roots.row) ? roots.row : {};
  return (
    <>
      {actions.control(0, row, "button", {
        button: ({ label, disabled, submitting, press }) => (
          <Displayed display={node.button} text={label} glyph="go">
            <button
              data-telo-part="button"
              data-button={node.button.type}
              data-state={submitting ? "submitting" : undefined}
              data-fill={node.fill === true ? "true" : undefined}
              data-style={styleAttribute(node.style)}
              type="button"
              disabled={disabled}
              onClick={press}
            />
          </Displayed>
        ),
      })}
      {actions.dialog}
    </>
  );
}
