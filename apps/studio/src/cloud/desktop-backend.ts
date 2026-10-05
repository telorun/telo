import { Channel, invoke } from "@tauri-apps/api/core";
import { isCloudIdentity, type CloudSessionSource, type CloudSessionState } from "./session";
import { CloudUnreachableError, type CloudRequest, type CloudTransport } from "./transport";

/** What a shell command rejects with. */
interface ShellError {
  code: string;
  message: string;
}

function isShellError(value: unknown): value is ShellError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ShellError).code === "string" &&
    typeof (value as ShellError).message === "string"
  );
}

const UNREACHABLE = new Set(["identity_provider_unreachable", "api_unreachable"]);

/** A response status that carries no body, which `Response` refuses one for. */
const BODILESS = new Set([204, 205, 304]);

/**
 * The desktop build's Cloud backend: every call is the shell's. The webview
 * passes a method, a path under the API base, headers and a body, and receives
 * the streamed answer; the access and refresh tokens never cross into it.
 */
export class DesktopCloudBackend implements CloudTransport, CloudSessionSource {
  request(request: CloudRequest): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let head: { status: number; headers: [string, string][] } | null = null;
      // The shell resolves the command with how many chunks it sent, and a
      // large chunk is fetched by the webview after that: the body ends when
      // the last one has arrived, not when the command resolves.
      let received = 0;
      let expected: number | null = null;
      let closed = false;
      const closeWhenComplete = () => {
        if (closed || expected === null || received < expected) return;
        closed = true;
        controller.close();
      };
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      const onHead = new Channel<{ status: number; headers: [string, string][] }>();
      onHead.onmessage = (message) => {
        head = message;
        resolve(
          new Response(BODILESS.has(message.status) ? null : body, {
            status: message.status,
            headers: message.headers,
          }),
        );
      };
      const onChunk = new Channel<ArrayBuffer>();
      onChunk.onmessage = (chunk) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk));
        received += 1;
        closeWhenComplete();
      };

      invoke<{ chunks: number; bytes: number }>("cloud_request", {
        request: {
          method: request.method,
          path: request.path,
          headers: Object.entries({ accept: "application/json", ...request.headers }),
          body: request.body ?? null,
        },
        onHead,
        onChunk,
      }).then(
        (sent) => {
          // The head may itself still be on its way: it is large enough to be
          // fetched once its headers pass a kibibyte.
          expected = sent.chunks;
          closeWhenComplete();
        },
        (err: unknown) => {
          const failure = toError(err);
          if (!head) reject(failure);
          else if (!closed) {
            closed = true;
            controller.error(failure);
          }
        },
      );
    });
  }

  read(): Promise<CloudSessionState> {
    return this.session("cloud_session");
  }

  signIn(): Promise<CloudSessionState> {
    return this.session("cloud_sign_in");
  }

  switchOrganization(): Promise<CloudSessionState> {
    return this.session("cloud_switch_organization");
  }

  async signOut(): Promise<void> {
    try {
      await invoke("cloud_sign_out");
    } catch (err) {
      throw toError(err);
    }
  }

  private async session(command: string): Promise<CloudSessionState> {
    let answer: unknown;
    try {
      answer = await invoke(command);
    } catch (err) {
      // Cloud could not be asked, so nothing is known about the grant: it is
      // kept, and the user is told rather than shown as signed out.
      if (isShellError(err) && UNREACHABLE.has(err.code)) {
        return { status: "unreachable", message: err.message };
      }
      throw toError(err);
    }
    const state = answer as { status?: unknown };
    if (state.status === "anonymous") return { status: "anonymous" };
    if (state.status === "signedIn" && isCloudIdentity(answer)) {
      const { user, org, permissions, expiresAt } = answer;
      return { status: "signedIn", identity: { user, org, permissions, expiresAt } };
    }
    throw new Error("The shell answered with a session Studio cannot read.");
  }
}

function toError(err: unknown): Error {
  if (isShellError(err)) {
    return UNREACHABLE.has(err.code) ? new CloudUnreachableError(err.message) : new Error(err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}
