# @telorun/tar

## 0.2.0

### Minor Changes

- 030bfdd: Add `std/gzip` (`Gzip.Encoder` / `Gzip.Decoder` — gzip ↔ gunzip a `Stream<Uint8Array>`) and `std/tar` (`Tar.Pack` — build a tar byte stream from `{ path, contents }` entries; `Tar.Extract` — pull one named entry out of a tar byte stream). Both are streaming, codec-composable building blocks for reading and writing `.tar.gz` payloads (e.g. module artifacts) without buffering the whole archive.
