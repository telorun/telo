/** A session request refused with an HTTP status and a `{ error, message }`
 *  body (plus whatever the refusal carries beside them). Thrown by the session
 *  lifecycle and the app-set rules, answered as is by the routes. */
export class SessionRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SessionRefusal";
  }

  get body(): Record<string, unknown> {
    return { error: this.error, message: this.message, ...this.extra };
  }
}
