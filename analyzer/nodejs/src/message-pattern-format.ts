/** The Node checker for the `message-pattern` Telo format: the message core's own
 *  pattern parser, so a slot of this format accepts exactly the patterns a Message
 *  holds. Browser-safe. */

import { parsePattern } from "@telorun/sdk";
import type { TeloFormatChecker } from "./telo-format.js";

export const messagePatternChecker: TeloFormatChecker = {
  check(value) {
    const result = parsePattern(value);
    if (result.ok) return undefined;
    return { reason: result.problem.message, offset: result.problem.range?.start ?? 0 };
  },
};
