import type {
  CancellationToken,
  EffectChain,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineStartError, EngineThread } from "./engine-thread.js";
import type { EngineJob, EngineWorkerData, ModelFile, RecognitionOptions } from "./engine-worker.js";
import { ENGINE_WORKER } from "./engine-worker.js";
import { ImageHeaderError, readImageHeader } from "./image-header.js";
import { RecognitionPool } from "./recognition-pool.js";
import type { RecognizedPage } from "./recognition-result.js";

// Loaded on the main thread only: the bundle is also the engine worker's entry,
// and a worker has no kernel for the SDK to resolve against.
type Sdk = typeof import("@telorun/sdk");
let sdkModule: Promise<Sdk> | undefined;
const loadSdk = (): Promise<Sdk> => (sdkModule ??= import("@telorun/sdk"));

const PAGE_SEGMENTATION = {
  autoOsd: 1,
  autoOnly: 2,
  auto: 3,
  singleColumn: 4,
  singleBlockVertical: 5,
  singleBlock: 6,
  singleLine: 7,
  singleWord: 8,
  circleWord: 9,
  singleChar: 10,
  sparseText: 11,
  sparseTextOsd: 12,
  rawLine: 13,
} as const;
type PageSegmentation = keyof typeof PAGE_SEGMENTATION;
const ORIENTATION_MODES: readonly PageSegmentation[] = ["autoOsd", "sparseTextOsd"];

const MODEL_CODE = /^[a-z][a-z0-9_]*$/;

interface RecognizerResource {
  kind: string;
  metadata: { name: string };
  languages: unknown[];
  orientationModel?: unknown;
  pageSegmentation?: PageSegmentation;
  concurrency?: unknown;
  queueLimit?: unknown;
  maxRecognitionTime?: unknown;
  maxImageBytes?: unknown;
  maxPixels?: unknown;
}

interface Region {
  x: unknown;
  y: unknown;
  width: unknown;
  height: unknown;
}

interface RecognizeInputs {
  image: Uint8Array;
  region?: Region;
  pageSegmentation?: PageSegmentation;
  characterWhitelist?: string;
  characterBlacklist?: string;
  preserveInterwordSpaces?: boolean;
  dpi?: unknown;
  include?: ("hocr" | "tsv")[];
}

type Recognition = RecognizedPage & { width: number; height: number };

interface Limits {
  readonly concurrency: number;
  readonly queueLimit: number;
  readonly maxRecognitionMs: number;
  readonly maxImageBytes: number;
  readonly maxPixels: number;
}

class TesseractRecognizer implements ResourceInstance<RecognizeInputs, Recognition> {
  private pool: RecognitionPool<EngineJob, RecognizedPage> | undefined;
  private readonly label: string;

  constructor(
    private readonly resource: RecognizerResource,
    private readonly ctx: ResourceContext,
    private readonly sdk: Sdk,
    private readonly pageSegmentation: PageSegmentation,
    private readonly limits: Limits,
  ) {
    this.label = `${resource.kind}/${resource.metadata.name}`;
  }

  init(): EffectChain<void> {
    return this.ctx.effect("tesseract engines", async () => {
      const data: EngineWorkerData = {
        [ENGINE_WORKER]: true,
        engineDir: fileURLToPath(await this.ctx.resolveControllerFile("./engine/")),
        languages: await this.languageModels(),
        ...(this.resource.orientationModel === undefined
          ? {}
          : { orientation: await this.orientationModel(this.resource.orientationModel) }),
      };
      const fail = (code: string, message: string) => new this.sdk.InvokeError(code, message);
      const pool = new RecognitionPool<EngineJob, RecognizedPage>({
        size: this.limits.concurrency,
        queueLimit: this.limits.queueLimit,
        maxRunMs: this.limits.maxRecognitionMs,
        fail,
        log: this.ctx.log,
        startEngine: () =>
          EngineThread.start(data, fail, (line) => this.ctx.log.debug("Engine output", { line })),
      });
      try {
        await pool.start();
      } catch (error) {
        if (error instanceof EngineStartError) {
          throw new this.sdk.RuntimeError(error.code, `${this.label}: ${error.message}`);
        }
        throw error;
      }
      this.pool = pool;
      return { result: undefined, inverse: () => pool.close() };
    });
  }

  async invoke(inputs: RecognizeInputs, invokeCtx?: InvokeContext): Promise<Recognition> {
    const token: CancellationToken = invokeCtx?.cancellation ?? this.sdk.NEVER_CANCELLED;
    const pool = this.pool;
    if (!pool) {
      throw new this.sdk.InvokeError("ERR_OCR_ENGINE_FAILED", `${this.label} has not been initialized.`);
    }
    const fail = (code: string, message: string) => new this.sdk.InvokeError(code, message);
    const image = inputs.image;
    if (image.byteLength > this.limits.maxImageBytes) {
      throw fail(
        "ERR_IMAGE_TOO_LARGE",
        `The image is ${image.byteLength} bytes; this recognizer accepts at most ${this.limits.maxImageBytes} (maxImageBytes).`,
      );
    }
    let header;
    try {
      header = readImageHeader(image);
    } catch (error) {
      if (error instanceof ImageHeaderError) throw fail("ERR_UNSUPPORTED_IMAGE", error.message);
      throw error;
    }
    const pixels = header.width * header.height;
    if (pixels > this.limits.maxPixels) {
      throw fail(
        "ERR_IMAGE_TOO_LARGE",
        `The image is ${header.width}x${header.height} (${pixels} pixels); this recognizer accepts at most ${this.limits.maxPixels} (maxPixels).`,
      );
    }
    const region = inputs.region === undefined ? undefined : this.region(inputs.region, header, fail);
    const pageSegmentation = inputs.pageSegmentation ?? this.pageSegmentation;
    const detectOrientation = ORIENTATION_MODES.includes(pageSegmentation);
    if (detectOrientation && this.resource.orientationModel === undefined) {
      throw fail(
        "ERR_INVALID_INPUT",
        `pageSegmentation '${pageSegmentation}' detects page orientation, but ${this.label} sets no orientationModel.`,
      );
    }
    const dpi = inputs.dpi === undefined ? undefined : this.sdk.integerInput(inputs.dpi);
    const options: RecognitionOptions = {
      pageSegMode: PAGE_SEGMENTATION[pageSegmentation],
      detectOrientation,
      ...(region ? { region } : {}),
      ...(inputs.characterWhitelist === undefined ? {} : { characterWhitelist: inputs.characterWhitelist }),
      ...(inputs.characterBlacklist === undefined ? {} : { characterBlacklist: inputs.characterBlacklist }),
      preserveInterwordSpaces: inputs.preserveInterwordSpaces === true,
      ...(dpi === undefined ? {} : { dpi }),
      include: inputs.include ?? [],
    };

    const started = performance.now();
    const page = await pool.submit({ image, format: header.format, options }, token);
    this.ctx.log.debug("Recognized an image", {
      "ocr.format": header.format,
      "ocr.duration_ms": Math.round(performance.now() - started),
      "ocr.words": page.words.length,
    });
    return { ...page, width: header.width, height: header.height };
  }

  private region(
    region: Region,
    image: { width: number; height: number },
    fail: (code: string, message: string) => Error,
  ): { x: number; y: number; width: number; height: number } {
    const x = this.sdk.integerInput(region.x);
    const y = this.sdk.integerInput(region.y);
    const width = this.sdk.integerInput(region.width);
    const height = this.sdk.integerInput(region.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      throw fail("ERR_INVALID_INPUT", "region's x, y, width and height must be integers.");
    }
    if (x + width > image.width || y + height > image.height) {
      throw fail(
        "ERR_INVALID_INPUT",
        `The region ${width}x${height} at (${x}, ${y}) reaches outside the ${image.width}x${image.height} image.`,
      );
    }
    return { x, y, width, height };
  }

  private async languageModels(): Promise<ModelFile[]> {
    const models: ModelFile[] = [];
    for (const [index, value] of this.resource.languages.entries()) {
      const model = await this.model(value, `languages[${index}]`, "TesseractModel.Language");
      if (typeof model.code !== "string" || !MODEL_CODE.test(model.code)) {
        throw new this.sdk.RuntimeError(
          "ERR_INVALID_VALUE",
          `${this.label}: languages[${index}] ('${model.resource}') publishes no valid language code.`,
        );
      }
      const clash = models.find((other) => other.code === model.code);
      if (clash || (model.code === "osd" && this.resource.orientationModel !== undefined)) {
        throw new this.sdk.RuntimeError(
          "ERR_INVALID_VALUE",
          `${this.label}: languages[${index}] ('${model.resource}') uses the code '${model.code}', which ` +
            (clash ? `'${clash.resource}' already uses` : "the orientation model's file takes") +
            ". The engine loads and reports a model by its code, so give a custom or fine-tuned " +
            "model a code of its own, such as 'eng_invoice'.",
        );
      }
      models.push({ resource: model.resource, path: model.path, code: model.code });
    }
    return models;
  }

  private async orientationModel(value: unknown): Promise<ModelFile> {
    const model = await this.model(value, "orientationModel", "TesseractModel.OrientationModel");
    return { resource: model.resource, path: model.path, code: "osd" };
  }

  /** A model's published reading: its `data` path and, for a language, its `code`. */
  private async model(
    value: unknown,
    field: string,
    expects: string,
  ): Promise<{ resource: string; path: string; code?: unknown }> {
    const instance = this.ctx.resolveRef(
      value,
      (candidate): candidate is ResourceInstance =>
        typeof candidate === "object" && candidate !== null && typeof (candidate as ResourceInstance).snapshot === "function",
      () => `${this.label}: ${field}`,
      expects,
    );
    const reading = (await instance.snapshot!()) as { data?: unknown; code?: unknown };
    const resource = this.sdk.getRefIdentity(instance)?.name ?? field;
    if (typeof reading.data !== "string" || !isAbsolute(reading.data)) {
      throw new this.sdk.RuntimeError(
        "ERR_MODEL_DATA_INVALID",
        `${this.label}: ${field} ('${resource}') publishes no absolute data path.`,
      );
    }
    return { resource, path: reading.data, code: reading.code };
  }
}

export function register(): void {}

export async function create(resource: RecognizerResource, ctx: ResourceContext): Promise<TesseractRecognizer> {
  const sdk = await loadSdk();
  const label = `${resource.kind}/${resource.metadata.name}`;
  const pageSegmentation = resource.pageSegmentation ?? "auto";
  if (ORIENTATION_MODES.includes(pageSegmentation) && resource.orientationModel === undefined) {
    throw new sdk.RuntimeError(
      "ERR_INVALID_VALUE",
      `${label}: pageSegmentation '${pageSegmentation}' detects page orientation and needs an orientationModel.`,
    );
  }
  const integer = (field: keyof RecognizerResource, fallback: number, minimum: number, maximum = Infinity) => {
    const raw = resource[field];
    const value = raw === undefined ? fallback : sdk.integerInput(raw);
    if (value === undefined || value < minimum || value > maximum) {
      throw new sdk.RuntimeError(
        "ERR_INVALID_VALUE",
        `${label}: ${field} must be an integer from ${minimum}${maximum === Infinity ? "" : ` to ${maximum}`}.`,
      );
    }
    return value;
  };
  const maxRecognitionMs =
    resource.maxRecognitionTime === undefined
      ? 120_000
      : resource.maxRecognitionTime instanceof sdk.Duration
        ? Number(resource.maxRecognitionTime.getMilliseconds())
        : Number.NaN;
  if (!(maxRecognitionMs > 0)) {
    throw new sdk.RuntimeError("ERR_INVALID_VALUE", `${label}: maxRecognitionTime must be a positive duration.`);
  }
  return new TesseractRecognizer(resource, ctx, sdk, pageSegmentation, {
    concurrency: integer("concurrency", 1, 1, 32),
    queueLimit: integer("queueLimit", 100, 0),
    maxRecognitionMs,
    maxImageBytes: integer("maxImageBytes", 25 * 1024 * 1024, 1),
    maxPixels: integer("maxPixels", 40_000_000, 1),
  });
}
