import type { TeloHostRequests } from "@telorun/editor-protocol";
import type { Connection } from "vscode-languageserver/browser";

/** The host's half of the protocol, typed by method. Every byte the engine
 *  reads arrives through here; a failed request rejects with the host's reason. */
export class HostClient {
  constructor(private readonly connection: Connection) {}

  request<M extends keyof TeloHostRequests>(
    method: M,
    params: TeloHostRequests[M][0],
  ): Promise<TeloHostRequests[M][1]> {
    return this.connection.sendRequest(method, params) as Promise<TeloHostRequests[M][1]>;
  }

  /** A failure the engine recovered from, reported where the host shows the
   *  engine's log rather than dropped. */
  log(message: string): void {
    this.connection.console.warn(message);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
