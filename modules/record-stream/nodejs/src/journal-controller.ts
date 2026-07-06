import type { ControllerContext, ResourceContext } from "@telorun/sdk";
import { JournalStore } from "./journal-store.js";

/**
 * RecordStream.Journal — a Provider whose instance is an in-memory, keyed,
 * offset-addressable replay buffer (see JournalStore). A producer streams into
 * it via RecordStream.JournalSink; a consumer reads a resumable stream from it
 * via RecordStream.JournalSource. It is process-local and holds no CEL config.
 */
export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: { metadata: { name: string; module?: string } },
  _ctx: ResourceContext,
): Promise<JournalStore> {
  return new JournalStore();
}
