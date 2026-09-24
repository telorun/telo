---
description: "Tesseract in production: concurrency and memory, queue and size limits, deadlines, and failure codes"
sidebar_label: Production tuning
---

# Production tuning

> Examples assume this module is imported under the alias `Tesseract`. Substitute your own alias if you import it under a different name.

## Concurrency against memory

A recognizer runs `concurrency` engine instances, each recognizing one image at a time. A recognition cannot be interrupted from inside, so an engine instance is the unit of parallelism and of stopping: stopping a recognition means stopping its engine and starting a fresh one.

Every engine instance holds its own copy of every configured model: roughly the WebAssembly engine, plus each language model decompressed (`eng` is about 5 MB), plus the orientation model when one is set, plus the image being read. Size `concurrency` to the cores you can give to recognition and to the memory that many engines need — adding engines beyond the cores gains nothing.

Each engine picks the fastest build its host supports: relaxed-SIMD, then SIMD, then plain WebAssembly.

The engines start when the recognizer initializes, so a model problem fails the application's boot, not its first call.

## Limits

| Field | Default | Refusal |
| --- | --- | --- |
| `queueLimit` | 100 | A call arriving while every engine is busy and `queueLimit` calls already wait is `ERR_OCR_OVERLOADED`. |
| `maxImageBytes` | 26214400 (25 MiB) | A larger encoded image is `ERR_IMAGE_TOO_LARGE`. |
| `maxPixels` | 40000000 | An image whose width times height exceeds it is `ERR_IMAGE_TOO_LARGE`. The size is read from the image header, so an oversized image is refused before it is decoded. |
| `maxRecognitionTime` | 120s | A recognition still running after this long is `ERR_OCR_LIMIT_EXCEEDED`. |

`ERR_OCR_OVERLOADED` means "not now": a caller may retry later, and a route handler can map it to a `503`.

## Deadlines

Bound a call with the step's `timeout:` (milliseconds). When it elapses the call is cancelled: a call still waiting leaves the queue, and a running recognition's engine is stopped and replaced by a fresh one. The step fails `ERR_STEP_TIMEOUT`.

```yaml
- name: read
  invoke: !ref recognizer
  timeout: 20000
  inputs:
    image: !cel "inputs.image"
```

`maxRecognitionTime` is the pool's own safety limit, not a caller deadline. It stops a pathological image from holding an engine for a caller that set no `timeout:`, such as a route handler invoking the recognizer directly. Queue wait does not count against it.

## Failure codes

| Code | Raised when |
| --- | --- |
| `ERR_INVALID_INPUT` | The region reaches outside the image, or a call selects `autoOsd` / `sparseTextOsd` on a recognizer without `orientationModel`. |
| `ERR_UNSUPPORTED_IMAGE` | The bytes are not PNG, JPEG, WebP, BMP or PNM, the header is truncated, or the engine's decoder cannot read them; the message carries the decoder's report. |
| `ERR_IMAGE_TOO_LARGE` | `maxImageBytes` or `maxPixels` is exceeded. |
| `ERR_OCR_OVERLOADED` | The queue is full. |
| `ERR_OCR_ENGINE_FAILED` | The call's engine crashed or aborted; it has already been replaced, so a retry may succeed. When a replacement cannot start and no engine is left, the waiting calls fail with this code naming the start failure, and the next call tries to start an engine again. A call still running or waiting when the recognizer is torn down also fails with this code. |
| `ERR_OCR_LIMIT_EXCEEDED` | The recognition ran past `maxRecognitionTime`; its engine has been replaced. |
| `ERR_MODEL_DATA_INVALID` | At boot, not per call: a model file is missing, unreadable, not valid gzip, or refused by the engine. |

A retry policy should leave out the codes a retry cannot fix:

```yaml
retry:
  attempts: 3
  nonRetryable: [ERR_INVALID_INPUT, ERR_UNSUPPORTED_IMAGE, ERR_IMAGE_TOO_LARGE, ERR_OCR_LIMIT_EXCEEDED]
```

## Logging

Each call logs its format, duration and word count at `debug`. Each engine replacement logs at `warn` with its cause, and a replacement that cannot start at `error`. Everything the engine itself prints is captured per call and never reaches the process's output; a decoder's report becomes the `ERR_UNSUPPORTED_IMAGE` message.
