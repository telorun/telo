// The wire format now lives in `@telorun/debug-wire` (the language-neutral
// frame contract shared by the producer, runner, editor, and this UI). This
// module re-exports it so the UI's internal `./wire.js` imports keep working.
export * from "@telorun/debug-wire";
