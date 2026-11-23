# Changelog

## 0.5.0 - 2026-11-22
### Added
* Each staged source declares the package its files are a release of (`purl` in `sources:`), and the `tessdata` source is split into `tessdata-eng` and `tessdata-osd`, one package each.
* The bill of materials lists every library tesseract.js-core 7.0.0 builds — tesseract (from the Balearica fork), leptonica, giflib, libjpeg, libpng, libtiff, libwebp, openlibm and zlib — each at the newest release its submodule pin's commit contains (libpng 1.6.37 though its source names the snapshot 1.6.38.git, openlibm 0.8.1), its CPE where the NVD names one, and the repository and commit of that pin, so telo audit checks them by commit.
* The `tesseract.js-core` source declares the Tesseract (5.3.0) and Leptonica (1.82.0) libraries compiled into its WebAssembly builds (`contains` in `sources:`), so a software bill of materials lists them.

## 0.4.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.4.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.3 - 2026-10-05
### Fixed
* A duration-valued field is read again: a duration is identified by a type key and carries no methods, so these controllers read one through durationNanos and build one with celDurationFromNanos instead of naming a class the CEL value domain no longer has — which failed at resource creation with 'isCelDuration is not defined', a missing 'Duration' export, or 'value.getMilliseconds is not a function'.

## 0.2.2 - 2026-10-04
### Fixed
* A duration-valued field is read again: a duration is identified by a type key and carries no methods, so these controllers read one through durationNanos and build one with celDurationFromNanos instead of naming a class the CEL value domain no longer has — which failed at resource creation with 'isCelDuration is not defined', a missing 'Duration' export, or 'value.getMilliseconds is not a function'.

## 0.2.1 - 2026-09-28
### Fixed
* A recognition that runs past `maxRecognitionTime` now always fails with `ERR_OCR_LIMIT_EXCEEDED`. Before, a result that reached the recognizer before the late limit timer fired was returned as a success, which happened on macOS.

## 0.2.0 - 2026-09-24
### Added
* Text recognition in images. `modules/ocr` is the engine-neutral contract: a recognizer reads the printed text in one image, optionally inside a pixel rectangle, and returns the text, a 0–1 confidence, the image size, and flat lists of blocks, lines and words linked by index, each with a box and polygon measured on the whole image. Its failure codes (ERR_INVALID_INPUT, ERR_UNSUPPORTED_IMAGE, ERR_IMAGE_TOO_LARGE, ERR_OCR_OVERLOADED, ERR_OCR_ENGINE_FAILED, ERR_OCR_LIMIT_EXCEEDED) are a ceiling every engine stays within, so a library holding any recognizer is checked against exactly that list, and a call is bounded by the step's `timeout:`. `modules/tesseract-model` declares Tesseract's trained models as resources — a language model named by its code and the orientation and script detection model — each located by a `.traineddata` file, gzip-compressed or raw, so a custom or fine-tuned model is one declaration. `modules/tesseract` implements the contract offline with the Tesseract engine compiled to WebAssembly, bundling the English and orientation models: it reads PNG, JPEG, WebP, BMP and PNM images, reports the page rotation and script with an orientation model, returns hOCR or TSV on request, and runs recognitions on a pool of worker threads with a queue limit, size limits read from the image header, and a per-recognition time limit (ERR_OCR_LIMIT_EXCEEDED); a cancelled call stops its engine.
