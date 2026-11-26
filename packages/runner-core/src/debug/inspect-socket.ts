import { connect } from "node:net";
import type { Duplex } from "node:stream";

/** A plain TCP connection to an inspect endpoint the runner reaches directly
 *  (a workload on the runner's own host), for `InspectEndpoint.connect`.
 *  Resolves once connected; a refused connection rejects. */
export function openInspectSocket(host: string, port: number, signal: AbortSignal): Promise<Duplex> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Duplex>((resolve, reject) => {
    const socket = connect({ host, port, signal });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}
