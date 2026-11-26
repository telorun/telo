import { useContext, useRef, type ReactNode } from "react";
import { styleAttribute, type Style } from "./bindings.js";
import { Displayed, type ButtonSpec } from "./display-button.js";
import type { MutationCallSpec } from "./mutation-call.js";
import { anchorRef } from "./node-anchors.js";
import { RootsContext } from "./renderer-context.js";
import { useMutationCalls } from "./mutation-calls.js";

/** A `button` node: a call of a mutation, and how its button is drawn. */
export interface ButtonNodeSpec {
  action: MutationCallSpec;
  button: ButtonSpec;
  style?: Style;
  fill?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A `button` node: its call run with the inputs it binds over the roots in
 * scope, labelled with the call's label and drawn as its display says. It is
 * drawn as a row's call is — its answer in place of the button, its failure
 * beside it or in the open confirmation, no press while one is pending.
 */
export function ButtonNode({ node }: { node: ButtonNodeSpec }): ReactNode {
  const roots = useContext(RootsContext);
  const drawn = useRef<HTMLElement | null>(null);
  const actions = useMutationCalls([node.action], roots, () => {}, () => drawn.current);
  // A button inside a record reads that record as `row`, as its other roots.
  const row = isRecord(roots.row) ? roots.row : {};
  return (
    <>
      {actions.control(0, row, "button", {
        button: ({ label, disabled, submitting, press }) => (
          <Displayed display={node.button} text={label} glyph="go">
            <button
              ref={(element) => {
                drawn.current = element;
                anchorRef(node)(element);
              }}
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
