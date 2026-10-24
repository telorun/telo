import { jsonPointerSegment, valueIssue, type ValueIssue } from "@telorun/sdk";
import { Ajv, type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import type { FastifyServerOptions } from "fastify";

/** Where in a request a refused value arrived — its member of `request` in CEL. */
export type RequestLocation = "query" | "params" | "body" | "headers";

/** A validator over the schemas the server shares; `coerceTypes` as Ajv reads it. */
function validatorOver(sharedSchemas: Record<string, unknown>, coerceTypes: false | "array"): Ajv {
  const ajv = new Ajv({
    coerceTypes,
    useDefaults: true,
    removeAdditional: false,
    addUsedSchema: false,
    allErrors: false,
  });
  addFormats.default(ajv);
  for (const shared of Object.values(sharedSchemas)) ajv.addSchema(shared as AnySchema);
  return ajv;
}

/**
 * The server options the request validator is built with. A part of a request
 * is read as its encoding carries it: a query, path-parameter or header value
 * is text by transport, so it is read into the type its schema declares; a body
 * arrives parsed and already typed, so it is validated as the value it is — a
 * `null` or a value of another JSON type at a typed property is refused, never
 * converted.
 */
export const requestValidation: Pick<FastifyServerOptions, "schemaController"> = {
  schemaController: {
    compilersFactory: {
      // Fastify's declared type gives the compiler a bare schema; it is called
      // with the route's schema and the part it belongs to.
      buildValidator: ((sharedSchemas: Record<string, unknown>) => {
        const text = validatorOver(sharedSchemas, "array");
        const typed = validatorOver(sharedSchemas, false);
        return ({ schema, httpPart }: { schema: AnySchema; httpPart?: string }) => {
          const ajv = httpPart === "body" ? typed : text;
          const id = typeof schema === "object" ? schema.$id : undefined;
          return (id && ajv.getSchema(id)) || ajv.compile(schema);
        };
      }) as never,
    },
  },
};

const VALIDATED_PARTS: Record<string, RequestLocation> = {
  body: "body",
  querystring: "query",
  params: "params",
  headers: "headers",
};

interface ValidatorFinding {
  instancePath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

/** The property a finding is about when the validator reports it on the
 *  object holding it: one that is missing, or one the schema does not declare. */
function namedProperty(finding: ValidatorFinding): unknown {
  if (finding.keyword === "required") return finding.params?.missingProperty;
  if (finding.keyword === "additionalProperties") return finding.params?.additionalProperty;
  return undefined;
}

/**
 * The findings of a request Fastify's validator refused, one per finding it
 * reported, each `{ pointer, keyword, params }`: the pointer into the request as
 * CEL reads it (`/body/items/0/name`, `/query/limit`) — naming the property for
 * one that is missing or undeclared — and the keyword and params in the issue
 * vocabulary. `null` for any other error, and for a validation error carrying no
 * findings, which then answers as an uncoded 400.
 */
export function fastifyValidationIssues(error: unknown): ValueIssue[] | null {
  const refusal = error as { code?: unknown; validationContext?: unknown; validation?: unknown } | null;
  if (!refusal || typeof refusal !== "object" || refusal.code !== "FST_ERR_VALIDATION") return null;
  const location = VALIDATED_PARTS[refusal.validationContext as string];
  if (!location || !Array.isArray(refusal.validation) || refusal.validation.length === 0) return null;
  return (refusal.validation as ValidatorFinding[]).map((finding) => {
    const named = namedProperty(finding);
    const pointer =
      `/${location}${finding.instancePath ?? ""}` +
      (typeof named === "string" ? `/${jsonPointerSegment(named)}` : "");
    return valueIssue(pointer, finding.keyword, finding.params);
  });
}

/**
 * The findings of a value `ctx.readPlainEncoded` refused at `location`, rebuilt
 * as exactly `{ pointer, keyword, params }` with the pointer from the request's
 * root; the value itself when the refusal names no finding.
 */
export function plainEncodedIssues(location: RequestLocation, data: unknown): ValueIssue[] {
  const issues = (data as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return [valueIssue(`/${location}`, undefined)];
  return issues.map((issue: { pointer?: unknown; keyword?: unknown; params?: unknown }) =>
    valueIssue(
      `/${location}${typeof issue.pointer === "string" ? issue.pointer : ""}`,
      typeof issue.keyword === "string" ? issue.keyword : undefined,
      issue.params && typeof issue.params === "object" ? (issue.params as Record<string, unknown>) : undefined,
    ),
  );
}
