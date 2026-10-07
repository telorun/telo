import { Ajv, type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import type { FastifyServerOptions } from "fastify";

/** Where in a request a refused value arrived. */
export type RequestLocation = "query" | "params" | "body" | "headers";

export interface RequestValidationDetail {
  location: RequestLocation;
  path: string;
  message: string;
}

/** The 400 body for a request its route's declared schema refuses — one shape,
 *  whether Fastify's validator refused the text or a plain-encoded slot could
 *  not be decoded from it. */
export function requestValidationEnvelope(details: RequestValidationDetail[]): Record<string, unknown> {
  return {
    error: "ValidationError",
    message: "Request validation failed",
    status: 400,
    details,
  };
}

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

const LIST_POSITION = /^\d+$/;

/**
 * The grammar of `details[].path`, from the validated part's root: property
 * names joined by `.`, and a list position — a segment made only of digits —
 * written `[n]` against what holds it, with no dot (`items[0].name`, `[0].name`
 * for a list at the root). A plain-encoded slot's refusal arrives from the
 * kernel already spelled this way.
 */
export function detailPath(segments: string[]): string {
  let path = "";
  for (const segment of segments) {
    if (LIST_POSITION.test(segment)) path += `[${segment}]`;
    else path += path === "" ? segment : `.${segment}`;
  }
  return path;
}

/** The segments of a JSON Pointer, unescaped. */
function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

interface ValidatorFinding {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}

/** The property a finding is about when the validator reports it on the
 *  object holding it: one that is missing, or one the schema does not declare. */
function namedProperty(finding: ValidatorFinding): unknown {
  if (finding.keyword === "required") return finding.params?.missingProperty;
  if (finding.keyword === "additionalProperties") return finding.params?.additionalProperty;
  return undefined;
}

/** The 400 body for a request Fastify's validator refused, one detail per finding
 *  the validator reported; `null` for any other error, and for a validation error
 *  carrying no findings, which Fastify's own default then answers. */
export function convertFastifyValidationError(error: any): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || error.code !== "FST_ERR_VALIDATION") {
    return null;
  }
  const location = VALIDATED_PARTS[error.validationContext as string];
  if (!location || !Array.isArray(error.validation)) return null;
  const details: RequestValidationDetail[] = error.validation.map((finding: ValidatorFinding) => {
    const segments = pointerSegments(finding.instancePath ?? "");
    const named = namedProperty(finding);
    if (typeof named === "string") segments.push(named);
    const message =
      finding.keyword === "required" && typeof named === "string"
        ? "is a required property"
        : (finding.message ?? "is invalid");
    return { location, path: detailPath(segments), message };
  });
  return requestValidationEnvelope(details);
}
