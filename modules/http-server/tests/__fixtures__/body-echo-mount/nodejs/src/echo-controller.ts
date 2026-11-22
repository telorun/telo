import type { ResourceInstance } from "@telorun/sdk";

interface Route {
  body: unknown;
}
interface Reply {
  header(name: string, value: string): Reply;
  send(payload: unknown): unknown;
}
interface App {
  addContentTypeParser(
    type: string,
    options: { parseAs: "buffer" },
    parser: (request: unknown, body: Buffer, done: (error: Error | null, value?: unknown) => void) => void,
  ): void;
  post(url: string, handler: (request: Route, reply: Reply) => unknown): void;
}

export function register(): void {}

export async function create(): Promise<ResourceInstance> {
  return {
    register(app: App, prefix: string) {
      app.addContentTypeParser("application/x-echo", { parseAs: "buffer" }, (_request, body, done) =>
        done(null, body),
      );
      app.post(`${prefix}/echo`, (request, reply) =>
        reply.header("content-type", "text/plain").send(Buffer.from(request.body as Buffer).toString("utf8")),
      );
    },
  } as ResourceInstance;
}
