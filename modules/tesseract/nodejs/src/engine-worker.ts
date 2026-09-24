import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { relaxedSimd, simd } from "wasm-feature-detect";
import { pageFromTesseract, type Orientation, type RecognizedPage, type TesseractJson } from "./recognition-result.js";

/**
 * The engine's side of a worker thread: this module's own bundle, started again
 * with {@link ENGINE_WORKER} in its worker data.
 *
 * Nothing here may evaluate `@telorun/sdk`: a worker has no Telo kernel, so the
 * SDK's realm shim throws when it loads. The bundle imports only types from it at
 * the top level.
 */

export const ENGINE_WORKER = "telo.tesseract.engine";

export interface ModelFile {
  /** The model resource's name, for messages. */
  readonly resource: string;
  readonly path: string;
  readonly code: string;
}

export interface EngineWorkerData {
  readonly [ENGINE_WORKER]: true;
  /** Absolute directory holding the staged engine builds. */
  readonly engineDir: string;
  readonly languages: readonly ModelFile[];
  readonly orientation?: ModelFile;
}

export interface RecognitionOptions {
  /** Tesseract page segmentation mode, 1–13. */
  readonly pageSegMode: number;
  readonly detectOrientation: boolean;
  readonly region?: { x: number; y: number; width: number; height: number };
  readonly characterWhitelist?: string;
  readonly characterBlacklist?: string;
  readonly preserveInterwordSpaces: boolean;
  readonly dpi?: number;
  readonly include: readonly ("hocr" | "tsv")[];
}

export interface EngineJob {
  readonly image: Uint8Array;
  /** The sniffed format, for the decoder's error message. */
  readonly format: string;
  readonly options: RecognitionOptions;
}

export type EngineRequest = EngineJob & { readonly id: number };

export type EngineReply =
  | { readonly type: "ready" }
  | { readonly type: "init-failed"; readonly code: string; readonly message: string }
  | { readonly type: "result"; readonly id: number; readonly page: RecognizedPage }
  | { readonly type: "error"; readonly id: number; readonly code: string; readonly message: string }
  | { readonly type: "fatal"; readonly id?: number; readonly message: string };

/** A failure of one call that leaves the engine usable. */
class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A model the engine could not load; fails the worker's start. */
class ModelError extends Error {}

const TESSDATA = "/tessdata";
const INPUT = "/input";
// The legacy engine is what orientation detection runs on; recognition is LSTM.
const OEM_LEGACY_ONLY = 0;
const OEM_LSTM_ONLY = 1;

// Only the engine's worker thread runs this; the kernel's load of the bundle
// does nothing here.
if (!isMainThread && (workerData as Partial<EngineWorkerData> | null)?.[ENGINE_WORKER] === true) {
  void serve(workerData as EngineWorkerData, parentPort!);
}

// The Emscripten module's surface this drives. Its WebIDL objects are untyped.
interface TesseractModule {
  FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  TessBaseAPI: new () => TessBaseAPI;
  OSResults: new () => OSResults;
  _malloc(size: number): number;
  _free(pointer: number): void;
  getValue(pointer: number, type: "i32"): number;
  destroy(object: unknown): void;
}

interface TessBaseAPI {
  Init(datapath: string, language: string, oem: number): number;
  End(): void;
  Clear(): void;
  SetImageFile(exifOrientation: number, angle: number): number;
  SetRectangle(left: number, top: number, width: number, height: number): void;
  SetSourceResolution(ppi: number): void;
  SetPageSegMode(mode: number): void;
  SetVariable(name: string, value: string): boolean;
  Recognize(monitor: null): number;
  GetJSONText(page: number): string;
  GetHOCRText(page: number): string;
  GetTSVText(page: number): string;
  DetectOS(results: OSResults): boolean;
  GetIterator(): ResultIterator;
}

interface ResultIterator {
  Orientation(orientation: number, writing: number, lineOrder: number, deskew: number): void;
  Next(level: number): boolean;
}

interface OSResults {
  readonly best_result: {
    readonly orientation_id: number;
    readonly script_id: number;
    readonly oconfidence: number;
  };
  readonly unicharset: { get_script_from_script_id(id: number): string };
}

const RIL_BLOCK = 0;

async function serve(data: EngineWorkerData, port: MessagePort): Promise<void> {
  const output: string[] = [];
  let engine: Engine;
  try {
    engine = await startEngine(data, output);
  } catch (error) {
    port.postMessage({
      type: "init-failed",
      code: error instanceof ModelError ? "ERR_MODEL_DATA_INVALID" : "ERR_OCR_ENGINE_FAILED",
      message: describe(error),
    } satisfies EngineReply);
    return;
  }
  port.postMessage({ type: "ready" } satisfies EngineReply);
  port.on("message", (request: EngineRequest) => {
    output.length = 0;
    try {
      const page = recognize(engine, request, output);
      port.postMessage({ type: "result", id: request.id, page } satisfies EngineReply);
    } catch (error) {
      if (error instanceof JobError) {
        port.postMessage({ type: "error", id: request.id, code: error.code, message: error.message } satisfies EngineReply);
        return;
      }
      // An abort leaves the WebAssembly instance unusable; the pool replaces the
      // worker when it reads this.
      port.postMessage({ type: "fatal", id: request.id, message: withOutput(describe(error), output) } satisfies EngineReply);
      port.close();
    }
  });
}

interface Engine {
  readonly module: TesseractModule;
  readonly api: TessBaseAPI;
  readonly orientationApi?: TessBaseAPI;
}

async function startEngine(data: EngineWorkerData, output: string[]): Promise<Engine> {
  const build = (await relaxedSimd()) ? "-relaxedsimd" : (await simd()) ? "-simd" : "";
  const loader = createRequire(import.meta.url)(join(data.engineDir, `tesseract-core${build}.js`)) as (
    options: object,
  ) => Promise<TesseractModule>;
  const module = await loader({
    // Asked even when the binary could be handed over, so it always names the staged file.
    locateFile: (file: string) => join(data.engineDir, file),
    print: (line: string) => output.push(line),
    printErr: (line: string) => output.push(line),
  });

  module.FS.mkdir(TESSDATA);
  for (const model of data.languages) writeModel(module, model, `${model.code}.traineddata`);
  if (data.orientation) writeModel(module, data.orientation, "osd.traineddata");

  const api = new module.TessBaseAPI();
  output.length = 0;
  if (initialize(api, data.languages.map((m) => m.code).join("+"), OEM_LSTM_ONLY, output) !== 0) {
    throw new ModelError(rejectedLanguages(module, data.languages, output));
  }
  if (!data.orientation) return { module, api };

  // Its own engine, with the orientation model loaded alone: detection reports
  // wrong results when a language is loaded ahead of it.
  const orientationApi = new module.TessBaseAPI();
  output.length = 0;
  if (initialize(orientationApi, "osd", OEM_LEGACY_ONLY, output) !== 0) {
    throw new ModelError(
      withOutput(
        `The orientation model '${data.orientation.resource}' at ${data.orientation.path} was rejected by the engine`,
        output,
      ),
    );
  }
  return { module, api, orientationApi };
}

function writeModel(module: TesseractModule, model: ModelFile, file: string): void {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(model.path);
  } catch (error) {
    throw new ModelError(`The model '${model.resource}' at ${model.path} cannot be read: ${describe(error)}`);
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch (error) {
      throw new ModelError(
        `The model '${model.resource}' at ${model.path} is not valid gzip data: ${describe(error)}`,
      );
    }
  }
  module.FS.writeFile(`${TESSDATA}/${file}`, bytes);
}

/** `Init`'s status. An abort inside it is a rejection, reported with the output. */
function initialize(api: TessBaseAPI, language: string, oem: number, output: string[]): number {
  try {
    return api.Init(TESSDATA, language, oem);
  } catch (error) {
    output.push(describe(error));
    return -1;
  }
}

/** Which language models the engine refuses, found by loading each alone. */
function rejectedLanguages(module: TesseractModule, languages: readonly ModelFile[], output: string[]): string {
  const combined = [...output];
  const rejected: string[] = [];
  for (const model of languages) {
    const probe = new module.TessBaseAPI();
    output.length = 0;
    if (initialize(probe, model.code, OEM_LSTM_ONLY, output) !== 0) {
      rejected.push(withOutput(`the model '${model.resource}' (${model.code}) at ${model.path}`, output));
    }
  }
  if (rejected.length > 0) return `The engine rejected ${rejected.join("; ")}`;
  return withOutput(
    `The engine rejected the language models ${languages.map((m) => `'${m.resource}' at ${m.path}`).join(", ")} together`,
    combined,
  );
}

/** One call, leaving no image or result behind in the engine. An abort is not
 *  cleaned up after: the worker is replaced, and cleaning a dead instance would
 *  throw over the abort's own cause. */
function recognize(engine: Engine, request: EngineRequest, output: string[]): RecognizedPage {
  engine.module.FS.writeFile(INPUT, request.image);
  const cleanUp = () => {
    engine.api.Clear();
    engine.module.FS.unlink(INPUT);
  };
  try {
    const page = recognizeInput(engine, request, output);
    cleanUp();
    return page;
  } catch (error) {
    if (error instanceof JobError) cleanUp();
    throw error;
  }
}

function recognizeInput(engine: Engine, request: EngineRequest, output: string[]): RecognizedPage {
  const { module, api, orientationApi } = engine;
  const { options } = request;

  api.SetVariable("tessedit_char_whitelist", options.characterWhitelist ?? "");
  api.SetVariable("tessedit_char_blacklist", options.characterBlacklist ?? "");
  api.SetVariable("preserve_interword_spaces", options.preserveInterwordSpaces ? "1" : "0");
  api.SetPageSegMode(options.pageSegMode);
  if (api.SetImageFile(1, 0) !== 0) {
    throw new JobError(
      "ERR_UNSUPPORTED_IMAGE",
      withOutput(`The engine could not decode the ${request.format.toUpperCase()} image`, output),
    );
  }
  if (options.dpi !== undefined) api.SetSourceResolution(options.dpi);
  if (options.region) {
    const { x, y, width, height } = options.region;
    api.SetRectangle(x, y, width, height);
  }

  let orientation: Orientation | undefined;
  if (options.detectOrientation && orientationApi) {
    orientation = detectOrientation(module, orientationApi, options);
  }

  if (api.Recognize(null) !== 0) {
    throw new JobError("ERR_OCR_ENGINE_FAILED", withOutput("The engine could not recognize the image", output));
  }
  const json = JSON.parse(api.GetJSONText(0)) as TesseractJson;
  const page: RecognizedPage = pageFromTesseract(json, blockOrientations(module, api, json.blocks?.length ?? 0));
  if (orientation) page.orientation = orientation;
  if (options.include.includes("hocr")) page.hocr = api.GetHOCRText(0);
  if (options.include.includes("tsv")) page.tsv = api.GetTSVText(0);
  return page;
}

/** Orientation and script detection, or undefined when the page has too little text to decide. */
function detectOrientation(
  module: TesseractModule,
  api: TessBaseAPI,
  options: RecognitionOptions,
): Orientation | undefined {
  if (api.SetImageFile(1, 0) !== 0) return undefined;
  if (options.dpi !== undefined) api.SetSourceResolution(options.dpi);
  if (options.region) {
    const { x, y, width, height } = options.region;
    api.SetRectangle(x, y, width, height);
  }
  const results = new module.OSResults();
  try {
    if (!api.DetectOS(results)) return undefined;
    const best = results.best_result;
    return {
      degrees: best.orientation_id * 90,
      script: results.unicharset.get_script_from_script_id(best.script_id),
      confidence: Math.max(0, best.oconfidence),
    };
  } finally {
    module.destroy(results);
    api.Clear();
  }
}

/** The orientation of each block, in the order `GetJSONText` lists them. */
function blockOrientations(module: TesseractModule, api: TessBaseAPI, count: number): number[] {
  if (count === 0) return [];
  const iterator = api.GetIterator();
  const out = module._malloc(16);
  const orientations: number[] = [];
  try {
    do {
      iterator.Orientation(out, out + 4, out + 8, out + 12);
      orientations.push(module.getValue(out, "i32"));
    } while (orientations.length < count && iterator.Next(RIL_BLOCK));
  } finally {
    module._free(out);
    module.destroy(iterator);
  }
  return orientations;
}

function withOutput(message: string, output: readonly string[]): string {
  const reported = output.map((line) => line.trim()).filter((line) => line !== "");
  return reported.length === 0 ? `${message}.` : `${message}: ${reported.join("; ")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
