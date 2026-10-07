import { createRoot } from "react-dom/client";

/** Leaves the root API to the host, which no ABI supplies. */
export function Unsupplied() {
  return <span>{typeof createRoot}</span>;
}
