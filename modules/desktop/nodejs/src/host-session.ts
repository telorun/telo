import { toPlainJson, type ResourceContext } from "@telorun/sdk";
import { HostConnection } from "./host-connection.js";

interface Shared {
  connection: Promise<HostConnection>;
  users: number;
}

/** One connection per fulfilment of the need, per kernel instance. */
const shared = new Map<string, Shared>();

export interface HostLease {
  readonly connection: HostConnection;
  /** Drops this holder's use; the last holder closes the connection. */
  release(): void;
}

/** Opens the fulfilment at `pointer` and shares its connection with every other holder. */
export async function acquireHost(ctx: ResourceContext, pointer: string): Promise<HostLease> {
  const need = ctx.resolveNeed(pointer);
  const key = `${ctx.kernelInstanceId}:${need.target.id}`;
  let entry = shared.get(key);
  if (!entry) {
    const endpoint = need.fields.endpoint as { scheme: string; path?: string };
    const text = String(toPlainJson(endpoint));
    entry = { connection: HostConnection.open(endpoint, text, String(need.fields.token)), users: 0 };
    shared.set(key, entry);
    const created = entry;
    // A failed open reaches every acquirer through its own await; an end nobody asked for is reported once here.
    created.connection.then(
      (connection) =>
        connection.onEnd((failure) => {
          if (!failure) return;
          ctx.log.error(`Desktop: the host connection was lost (${failure.code}): ${failure.message}`, undefined, {
            eventName: failure.code,
          });
          ctx.requestExit(1);
        }),
      () => {
        if (shared.get(key) === created) shared.delete(key);
      },
    );
  }
  entry.users++;
  const held = entry;
  let released = false;
  let connection: HostConnection;
  try {
    connection = await held.connection;
  } catch (err) {
    held.users--;
    throw err;
  }
  return {
    connection,
    release() {
      if (released) return;
      released = true;
      if (--held.users === 0) {
        if (shared.get(key) === held) shared.delete(key);
        connection.close();
      }
    },
  };
}
