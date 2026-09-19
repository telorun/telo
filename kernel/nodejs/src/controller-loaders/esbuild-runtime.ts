/**
 * Getting hold of esbuild, which the kernel needs to build a controller from
 * source and which does not always arrive as an installed package.
 *
 * esbuild is two things: a JavaScript API and a native executable it talks to.
 * In an npm install both come from `node_modules` and there is nothing to
 * arrange. In a single-file executable the API is compiled in, but the
 * executable cannot be — so the host unpacks it and says where it went, through
 * `setEsbuildExecutableProvider`. The provider is consulted once, lazily, and
 * only when the environment has not already named an executable itself.
 *
 * **Only the asynchronous API is ever used.** esbuild's synchronous entry points
 * start a worker from the running program's own path, which in a single-file
 * executable re-enters the program instead of starting a worker, and the call
 * never returns — measured. The kernel has always used the asynchronous API; the
 * point of writing it down here is that it is a requirement, not a preference.
 */

/** Where the host says esbuild's executable is, resolved on first use. Returning
 *  `undefined` means "nothing to arrange" — the ordinary installed case. */
export type EsbuildExecutableProvider = () => Promise<string | undefined>;

let provider: EsbuildExecutableProvider | undefined;

/** Registered by a host that carries esbuild's executable rather than installing
 *  it: the standalone binary. Set before the first controller build. */
export function setEsbuildExecutableProvider(next: EsbuildExecutableProvider): void {
  provider = next;
}

/** Memoized esbuild handle: `undefined` until first tried, `null` when absent. A
 *  failed dynamic import is not reliably cached by Node, so without this every
 *  controller load re-attempts (and re-fails) the import. */
let esbuildModule: typeof import("esbuild") | null | undefined;

export async function loadEsbuild(): Promise<typeof import("esbuild") | null> {
  if (esbuildModule !== undefined) return esbuildModule;
  // `ESBUILD_BINARY_PATH` is esbuild's own override, so an environment that
  // already sets it has answered the question and the provider is not asked.
  if (provider && !process.env.ESBUILD_BINARY_PATH) {
    try {
      const executable = await provider();
      if (executable) process.env.ESBUILD_BINARY_PATH = executable;
    } catch {
      // Unpacking failed — fall through to the import, which either finds an
      // installed esbuild or reports its own absence to the caller.
    }
  }
  try {
    esbuildModule = await import("esbuild");
  } catch {
    esbuildModule = null;
  }
  return esbuildModule;
}
