import { isTauri } from "@tauri-apps/api/core";
import { DesktopCloudBackend } from "./desktop-backend";
import type { CloudSessionSource } from "./session";
import type { CloudTransport } from "./transport";
import { WebCloudBackend } from "./web-backend";

export type CloudBackend = CloudTransport & CloudSessionSource;

let backend: CloudBackend | null = null;

/** The one place the build target decides how Cloud is reached. */
export function cloudBackend(): CloudBackend {
  backend ??= isTauri() ?new DesktopCloudBackend() : new WebCloudBackend();
  return backend;
}
