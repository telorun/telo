import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { create as createReader, type CollectionPage, type ReaderResource } from "./reader-controller.js";
import { etagOf } from "./record-precondition.js";

interface RecordInputs {
  id: unknown;
}

interface RecordRead {
  row: Record<string, unknown> | null;
  etag: string | null;
}

/** Reads one row by its key through the collection's reader, and its strong validator. */
class RecordReader implements ResourceInstance {
  constructor(private readonly reader: ResourceInstance & { invoke(inputs: unknown, invokeCtx?: InvokeContext): Promise<unknown> }) {}

  async invoke(inputs: RecordInputs, invokeCtx?: InvokeContext): Promise<RecordRead> {
    const page = (await this.reader.invoke({ filters: [{ property: "id", value: inputs.id }], limit: 1 }, invokeCtx)) as CollectionPage;
    const row = page.rows[0];
    return row ? { row, etag: etagOf(row) } : { row: null, etag: null };
  }
}

export async function create(resource: ReaderResource, ctx: ResourceContext): Promise<ResourceInstance> {
  const reader = await createReader({ ...resource, query: { filters: [{ property: "id", operator: "eq" }], sort: [] } }, ctx);
  return new RecordReader(reader as RecordReader["reader"]);
}
