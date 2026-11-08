import { InvokeError, type Logger, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { FsManifest, requirePath, resolveBase, resolveTarget, wrapFsError } from "./fs-support.js";
import { assertTransferable, makeParents, placeNew, withCleanup } from "./path-transfer.js";

interface MoveInput {
  path: string;
  destination: string;
}

interface MoveResult {
  moved: string;
  destination: string;
}

class MoveResource implements ResourceInstance<MoveInput, MoveResult> {
  constructor(
    private readonly base: string,
    private readonly log: Logger,
  ) {}

  private classify(err: unknown, source: string, destination: string): Error {
    if (err instanceof InvokeError) return err;
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return new InvokeError(
        "ERR_MOVE_CROSS_DEVICE",
        `Fs.Move: '${source}' and '${destination}' are on different filesystems; a rename cannot cross them.`,
        { path: source, destination },
      );
    }
    return wrapFsError("Fs.Move: cannot move", source, err);
  }

  async invoke(input: MoveInput): Promise<MoveResult> {
    const source = resolveTarget(this.base, requirePath("Fs.Move", input?.path));
    const destination = resolveTarget(this.base, requirePath("Fs.Move", input?.destination));
    await assertTransferable("Fs.Move", source, destination, "ERR_MOVE_INTO_ITSELF");

    let undoParents: () => Promise<void>;
    try {
      undoParents = await makeParents(destination);
    } catch (err) {
      throw wrapFsError("Fs.Move: cannot create parents of", destination, err);
    }
    try {
      await placeNew("Fs.Move", source, destination);
    } catch (err) {
      throw await withCleanup(this.classify(err, source, destination), undoParents);
    }
    this.log.info("Moved", { "file.path": source, "fs.destination": destination });
    return { moved: input.path, destination: input.destination };
  }
}

export function register(): void {}

export async function create(resource: FsManifest, ctx: ResourceContext): Promise<MoveResource> {
  return new MoveResource(resolveBase(resource.cwd), ctx.log);
}
