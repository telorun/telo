// The same suite twice: under Node, and under a browser-like environment, so a
// Node-only global reached by the package fails one of them.
export default [
  { test: { name: "node", environment: "node", include: ["tests/**/*.test.ts"] } },
  { test: { name: "browser", environment: "jsdom", include: ["tests/**/*.test.ts"] } },
];
