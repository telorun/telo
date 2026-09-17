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
