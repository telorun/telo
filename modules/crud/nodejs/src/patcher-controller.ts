import { InvokeError, integerInput, jsonPointerSegment, valueIssue, type InvokeContext, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { mergePatch } from "./merge-patch.js";
import { lockStatement, replaceStatement } from "./collection-statement.js";
import { decodeRow, type JsonSchema } from "./model-properties.js";
import { modelSchema } from "./model-schema.js";
import { etagOf, preconditionFailed, preconditionHolds } from "./record-precondition.js";
import { inTransaction } from "./write-transaction.js";
import { Writer, type WriterResource } from "./writer.js";

export const PATCH_INVALID = "ERR_CRUD_PATCH_INVALID";

interface PatchInputs {
  id: unknown;
  /** The merge patch; anything but an object is refused. */
  data: unknown;
  ifMatch?: string | null;
}

interface Patched {
  rowCount: number;
  row?: Record<string, unknown>;
  etag?: string;
}

/**
 * Applies a JSON Merge Patch to one row. Under the row's write lock it reads
 * the record, checks the `If-Match` validator, merges the patch over it and
 * holds the result to the update shape whole, then sets only the columns the
 * patch names. A member holding a value sets its property (an object merges
 * into the stored one member by member), `null` clears it, and a property the
 * patch leaves out is untouched.
 */
class Patcher extends Writer implements ResourceInstance {
  private validator?: ValidateFunction;

  async invoke(inputs: PatchInputs, invokeCtx?: InvokeContext): Promise<Patched> {
    const connection = this.connection();
    const owner = `Crud.Patcher '${this.resource.metadata.name}'`;
    const id = integerInput(inputs.id) ?? inputs.id;
    const patch = readPatch(inputs.data ?? {}, owner);
    return inTransaction(this.ctx, connection, invokeCtx, async (zone) => {
      const lock = lockStatement(connection.dialect, this.resource.table, id, this.readable.values());
      const held = (await connection.execute<Record<string, unknown>>(lock.sql, lock.params, zone, invokeCtx)).rows[0];
      if (!held) return { rowCount: 0 };
      const current = decodeRow(this.readable, held);
      if (!preconditionHolds(inputs.ifMatch, etagOf(current))) throw preconditionFailed(owner);
      const merged = this.merged(current, patch);
      this.requireValid(merged, owner);
      const named = [...this.writable.values()].filter((property) => Object.hasOwn(patch, property.name));
      if (named.length === 0) return { rowCount: 1, row: current, etag: etagOf(current) };
      const set = replaceStatement(connection.dialect, this.resource.table, named, id, merged, this.readable.values());
      const stored = (await connection.execute<Record<string, unknown>>(set.sql, set.params, zone, invokeCtx)).rows[0];
      if (!stored) return { rowCount: 0 };
      const row = decodeRow(this.readable, stored);
      return { rowCount: 1, row, etag: etagOf(row) };
    });
  }

  /** The record the update shape judges: what it declares of the stored one, the
   *  patch merged over it (RFC 7396, objects member by member), and any member the
   *  patch names that it does not declare. */
  private merged(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const name of this.writable.keys()) {
      if (!Object.hasOwn(patch, name)) {
        if (current[name] !== undefined) merged[name] = current[name];
      } else {
        const value = mergePatch(current[name], patch[name]);
        if (value !== null) merged[name] = value;
      }
    }
    for (const [name, value] of Object.entries(patch)) {
      if (!this.writable.has(name)) merged[name] = value;
    }
    return merged;
  }

  private requireValid(candidate: Record<string, unknown>, owner: string): void {
    this.validator ??= compile(modelSchema(this.resource.model, this.ctx, owner));
    if (this.validator(candidate)) return;
    const issues = (this.validator.errors ?? []).map((finding) => {
      const params = finding.params as Record<string, unknown>;
      const named =
        finding.keyword === "required"
          ? params.missingProperty
          : finding.keyword === "additionalProperties"
            ? params.additionalProperty
            : undefined;
      return valueIssue(
        `/body${finding.instancePath}${typeof named === "string" ? `/${jsonPointerSegment(named)}` : ""}`,
        finding.keyword,
        params,
      );
    });
    throw new InvokeError(PATCH_INVALID, `${owner}: the patched record is not valid against the update shape.`, { issues });
  }
}

function readPatch(data: unknown, owner: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new InvokeError(PATCH_INVALID, `${owner}: the body is not a JSON object.`, {
      issues: [valueIssue("/body", "type", { type: "object" })],
    });
  }
  return data as Record<string, unknown>;
}

function compile(schema: JsonSchema): ValidateFunction {
  // The options the server validates a `PUT` body with.
  const ajv = new Ajv({ useDefaults: true, removeAdditional: false, addUsedSchema: false, allErrors: false });
  addFormats.default(ajv);
  return ajv.compile(schema);
}

export async function create(resource: WriterResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new Patcher(resource, ctx, `Crud.Patcher '${resource.metadata.name}'`);
}
