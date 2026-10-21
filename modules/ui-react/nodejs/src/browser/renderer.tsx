import "./base.css";
import { mount } from "./app.js";

// The renderer: loaded by the shell, it draws the application into the
// shell's root element.
export { mount };
// The message core it formats every text with, as built into this entry.
export {
  formatMessage,
  formatNumber,
  invalidPluralCategories,
  lookupLanguage,
  messageIdentity,
  messageVariables,
  parsePattern,
  pluralCategories,
  pluralCategory,
  pluralCategoryOfDecimal,
  readMessage,
  readText,
  serializePattern,
  textIdentity,
  truncationChain,
  unknownVariables,
} from "@telorun/message-format";

const root = typeof document === "undefined" ? null : document.getElementById("telo-root");
if (root) mount(root);
