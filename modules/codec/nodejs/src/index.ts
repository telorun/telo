/**
 * Public types for the codec module. Concrete codec packages (plain-text-codec,
 * ndjson-codec, sse-codec, octet-codec, third-party formats) implement these
 * shapes and extend the `Encoder` / `Decoder` abstracts via `extends:` in their
 * own `telo.yaml` files. The abstracts themselves have no controllers — they
 * are pure contracts.
 */
import type { Stream } from "@telorun/sdk";

export type EncoderInputs<TIn = unknown> = { input: Stream<TIn> };
export type EncoderOutputs = { output: Stream<Uint8Array> };

export type DecoderInputs = { input: Stream<Uint8Array> };
