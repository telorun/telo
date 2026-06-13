// The Telo debug wire format: the language-neutral frame contract shared by the
// producer (kernel runtime / CLI), the runner that relays it, the editor, and
// the debug UI. Browser-safe — no Node built-ins, no framework — so every
// consumer can depend on it without a wrong-direction coupling.
export {
  type DebugEvent,
  type DebugLog,
  type DebugFrame,
  type WireRef,
  type WireBlob,
  isLogFrame,
  isEventFrame,
  isWireRef,
  isWireBlob,
  eventSuffix,
} from "./wire.js";
