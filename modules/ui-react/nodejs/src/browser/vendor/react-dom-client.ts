import Package from "react-dom/client";

// The root API of the page's one React, under `react-dom/client`. Every name is listed: the package is CommonJS, so
// nothing but an explicit list gives the built module named exports.
const namespace = Package as unknown as Record<string, any>;

export default Package;
export const {
  createRoot,
  hydrateRoot,
  version,
} = namespace;
