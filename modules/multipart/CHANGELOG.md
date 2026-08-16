# Changelog

## 0.2.1 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.2.0 - 2026-08-16
### Added
* New module. Multipart.Encoder combines an ordered list of parts — a JSON document, a form field, a file — into one payload with boundary framing, and returns it with the media type to send it under, because the generated boundary must appear in both and a hand-written header cannot carry it. Part content may be text, bytes or a byte stream, and a streamed part is written through rather than buffered. Multipart.Decoder is the inbound half, reading the boundary from the media type the sender supplied. form-data, related and mixed are one framing under different media types. Multipart.Reader is the incremental counterpart to Decoder — a stream of parts, each a stream of bytes — for uploads too large to hold whole; advancing past a part discards its remainder — for a partial read as well as a skipped one, since the drain runs on the reader's own source rather than on the stream the consumer holds — so stopping early is safe rather than a silent misread.
