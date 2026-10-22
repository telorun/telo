import type { Semantics } from "../../../../ui-react/nodejs/src/contract/ui-react-controls.js";

/** The relations and conditions a control forwards to its focusable element. */
export function aria(semantics: Pick<Semantics, "label" | "describedBy" | "invalid"> & { required?: boolean }) {
  return {
    "aria-label": semantics.label,
    "aria-describedby": semantics.describedBy || undefined,
    "aria-invalid": semantics.invalid ? true : undefined,
    "aria-required": semantics.required ? true : undefined,
  };
}

export const invalidMark = (invalid: boolean) => (invalid ? "true" : undefined);
