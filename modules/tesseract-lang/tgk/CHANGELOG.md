# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-24
### Added
* One module per language Tesseract ships a model for, published as `oci://ghcr.io/telorun/tesseract-lang/<code>`. Each exports one ready-made language model named after its code, for a recognizer's `languages:` list, and imports only the model kinds, never the engine, so importing a language opens no second engine and fetches only that model. The models are the integer-quantized best models of tesseract-ocr/tessdata, pinned by sha256 and shipped under their Apache-2.0 notice.
