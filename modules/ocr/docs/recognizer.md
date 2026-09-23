---
description: "Ocr.Recognizer: the engine-neutral contract for reading printed text in one image"
sidebar_label: Ocr.Recognizer
---

# Ocr.Recognizer

> Examples assume this module is imported under the alias `Ocr`. Substitute your own alias if you import it under a different name.

`Ocr.Recognizer` is an abstract `Telo.Invocable`: the contract every OCR engine implements. It has no implementation of its own. An engine module declares a kind with `extends: Ocr.Recognizer`, and the application declares that kind.

Type a slot against this abstract when it should accept any engine: a library's `resources:` entry (`recognizer: { kind: Ocr.Recognizer }`), a template's reference slot, a blueprint's input. Declare the engine's own kind only where the engine is chosen.

## Scope: one image

One call reads one image. Several pages are handled by composition: rasterize a PDF into page images, then iterate over them with the step grammar. Key-value, table and form extraction are a different contract and never become fields here.

## Input

| Field | Type | Meaning |
| --- | --- | --- |
| `image` | bytes, required | The encoded image. Which formats are accepted is the engine's to document. |
| `region` | `{ x, y, width, height }`, integers | Only this rectangle is read, in pixels from the top-left corner. `width` and `height` are at least 1. |

An engine may accept more inputs of its own. Each one is optional, so a caller written against this contract works with every engine.

## Output

| Field | Meaning |
| --- | --- |
| `text` | The full text. Lines are separated by `\n`, blocks by a blank line. |
| `confidence` | The mean confidence over the recognized words, from 0 to 1. |
| `width`, `height` | The input image's size in pixels. |
| `blocks[]` | `{ text, confidence, box, polygon }` |
| `lines[]` | `{ text, confidence, box, polygon, block }` |
| `words[]` | `{ text, confidence, box, polygon, line }` |

The lists are flat and in reading order. `line.block` is the index into `blocks` of the enclosing block, and `word.line` the index into `lines` of the enclosing line. A flat list is what CEL filters directly, and what an overlay takes as it is:

```yaml
outputs:
  sure: !cel "steps.read.result.words.filter(w, w.confidence >= 0.8).map(w, w.text)"
  firstLine: !cel "steps.read.result.words.filter(w, w.line == 0).map(w, w.text).join(' ')"
```

### Coordinates

- `box` is `{ x, y, width, height }` in integer pixels: the element's axis-aligned bounds.
- `polygon` is always present: the element's corner points `[{ x, y }, …]` in integer pixels, clockwise from the top-left corner of the text. An engine that detects rotated text reports the rotated outline, which an axis-aligned box cannot carry. An engine that only knows boxes reports the box's four corners.
- Both are measured on the **whole image**, even when `region` was given. That is the coordinate space a rasterized page is produced in and an image overlay draws in, so recognized words can be drawn back onto the page without conversion.

## Failures

Every implementation reports these codes. They are declared on the contract, so a `catches:` list or a retry policy written against it holds for any engine.

| Code | Meaning to the caller |
| --- | --- |
| `ERR_INVALID_INPUT` | The call was malformed: a region reaching outside the image, or a parameter the engine cannot accept. Fix the call. |
| `ERR_UNSUPPORTED_IMAGE` | The bytes are not a readable image in a format the engine supports. |
| `ERR_IMAGE_TOO_LARGE` | The image exceeds the engine's size limits, in bytes or pixels. |
| `ERR_OCR_OVERLOADED` | The engine has no capacity for the call right now. Retrying later may succeed. |
| `ERR_OCR_ENGINE_FAILED` | The engine failed while recognizing. The same call may succeed if retried. |
| `ERR_OCR_LIMIT_EXCEEDED` | The engine stopped the call at one of its own limits, such as how long one recognition may run. Retrying the same input is unlikely to help. |

This list is a **ceiling**: an engine declares any subset of it and nothing beyond it, so a caller holding any recognizer knows every code it can be handed. `telo check` reports an engine declaring another code (`THROWS_NOT_SUBSTITUTABLE`), and the runtime refuses such an engine when it loads. A library that takes a recognizer through `resources: { recognizer: { kind: Ocr.Recognizer } }` has its `catches:` checked against exactly this list. How an engine produces each code is documented on the engine.

## Deadlines are the caller's

The contract has no timeout. Bound a call with the step's `timeout:`, in milliseconds; when it elapses the invocation is cancelled and the step fails `ERR_STEP_TIMEOUT`:

```yaml
steps:
  - name: read
    invoke: !ref recognizer
    timeout: 30000
    retry:
      attempts: 3
      nonRetryable: [ERR_INVALID_INPUT, ERR_UNSUPPORTED_IMAGE, ERR_IMAGE_TOO_LARGE, ERR_OCR_LIMIT_EXCEEDED]
    inputs:
      image: !cel "inputs.page"
```

Every implementation must stop its work when the invocation is cancelled, so a timed-out call does not keep an engine busy.

## Mapping an engine onto the contract

For someone implementing `Ocr.Recognizer` over another engine:

- **Polygons.** An engine reporting rotated or free-form regions puts its points in `polygon`, starting at the top-left corner of the text and going clockwise, and puts their axis-aligned bounds in `box`.
- **Hierarchy.** An engine with paragraphs, lines and words maps them to `blocks`, `lines` and `words`. One with fewer levels reports each missing level as one element per element of the level below, so the indices stay valid.
- **Confidence.** Scale the engine's score to 0–1. `confidence` at the top level is the mean over `words`.
- **Per-page results.** An engine that returns results per page is called with one image, and reports that page only.
- **Region.** An engine that cannot crop is handed the cropped image, and its coordinates are shifted back onto the whole image.
- **Rate limits and quotas.** A refusal that means "not now" is `ERR_OCR_OVERLOADED`. A transient service or engine error is `ERR_OCR_ENGINE_FAILED`. Neither is retried inside the implementation. The caller's retry policy decides.
- **The engine's own limits.** A page limit, a processing-time limit or a quota on one call's size is `ERR_OCR_LIMIT_EXCEEDED`, with the limit named in the message. A failure that fits no code in the list is reported under the closest one rather than a new code, which the contract would refuse.
- **Cancellation.** Abort the request or stop the engine when the invocation is cancelled.
