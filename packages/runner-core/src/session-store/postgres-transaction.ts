import type { Pool, PoolClient } from "pg";

/** Runs `body` in one transaction on its own connection, rolling back on a throw. */
export async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    try {
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollback) {
        // The connection's state is unknown: destroy it rather than pool it. The body's error is the one thrown.
        broken = rollback as Error;
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}
