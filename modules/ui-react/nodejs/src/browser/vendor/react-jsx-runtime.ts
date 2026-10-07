import Package from "react/jsx-runtime";

// The JSX runtime of the page's one React, under `react/jsx-runtime`. Every name is listed: the package is CommonJS, so
// nothing but an explicit list gives the built module named exports.
const namespace = Package as unknown as Record<string, any>;

export default Package;
export const {
  Fragment,
  jsx,
  jsxs,
} = namespace;
