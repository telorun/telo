/** The Node checker for the `path-template` Telo format: the path-template
 *  reader's own verdict, its reason and the offset it is about. Browser-safe. */

import { readPathTemplate } from "./path-template-reading.js";
import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

export const pathTemplateChecker: TeloFormatChecker = {
  check(value: string): TeloFormatFailure | undefined {
    const reading = readPathTemplate(value);
    return "invalid" in reading ? { reason: reading.invalid, offset: reading.offset } : undefined;
  },
};
