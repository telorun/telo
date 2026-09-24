import type { ResourceInstance } from "@telorun/sdk";

interface ModelResource {
  metadata: { name: string; module?: string };
  data: string;
  code?: string;
}

/**
 * A trained model file, shared by `Language` and `OrientationModel`. It loads
 * nothing: a recognizer reads the published `data` (and `code`, for a language)
 * and loads the file into its own engine, so a model declared against one
 * version of this module works with a recognizer built against another.
 */
class TesseractModel implements ResourceInstance {
  constructor(
    private readonly data: string,
    private readonly code: string | undefined,
  ) {}

  snapshot(): Record<string, unknown> {
    return this.code === undefined ? { data: this.data } : { data: this.data, code: this.code };
  }
}

export function register(): void {}

export async function create(resource: ModelResource): Promise<TesseractModel> {
  return new TesseractModel(resource.data, resource.code);
}
