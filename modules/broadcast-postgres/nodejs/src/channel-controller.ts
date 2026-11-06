import { broadcastSettingsOf } from "@telorun/broadcast";
import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import {
  isPostgresConnection,
  NOTIFICATION_PAYLOAD_LIMIT,
  PostgresBroadcastChannel,
  type PostgresConnection,
} from "./postgres-channel.js";

interface ChannelResource {
  metadata: { name: string; module?: string };
  name: string;
  messageType: unknown;
  maxBytes?: number;
  connection: unknown;
}

/** BroadcastPostgres.Channel — a broadcast channel over a connection's `listen` / `notify`. */
export async function create(resource: ChannelResource, ctx: ResourceContext): Promise<PostgresBroadcastChannel> {
  const describe = `BroadcastPostgres.Channel "${resource.metadata.name}"`;
  const settings = broadcastSettingsOf(resource, ctx);
  if (settings.maxBytes > NOTIFICATION_PAYLOAD_LIMIT) {
    throw new RuntimeError(
      "ERR_BROADCAST_MAX_BYTES_EXCEEDS_BACKEND",
      `${describe}: 'maxBytes' is ${settings.maxBytes}, above ${NOTIFICATION_PAYLOAD_LIMIT}, the largest ` +
        `notification payload PostgreSQL accepts. Lower the bound.`,
    );
  }
  const connection: PostgresConnection = ctx.resolveRef(
    resource.connection,
    isPostgresConnection,
    () => `${describe}: 'connection'`,
    "Postgres.Connection",
  );
  return new PostgresBroadcastChannel(settings, connection, ctx);
}
