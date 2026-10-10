# Changelog

## 0.4.0 - 2026-10-10
### Added
* Multipart.Decoder and Multipart.Reader take three limits, each an integer of at least 1: maxPartBytes (one part's content; decoder default 8388608, reader none), maxParts (default 1000 on both) and maxTotalBytes (every byte read, framing and headers included; decoder default 16777216, reader none). Both declare two codes with typed data: ERR_MULTIPART_MALFORMED with data.reason boundary-missing, truncated, header-malformed or header-too-large, and ERR_MULTIPART_LIMIT_EXCEEDED with data limit, max and, where a part is concerned, part and name. A limit stops the read as soon as the bytes read show it is crossed, a source failure is rethrown as raised, and on the reader a failure found while draining fails the read in progress and the parts stream and releases the source. Breaking: failures were uncoded errors rendered as 500 and are now coded, so a route whose handler is a decoder or a reader must cover both codes in catches or telo check reports UNCOVERED_THROW_CODE. Breaking: maxPartBytes no longer caps the whole payload; that cap is maxTotalBytes, 16 MiB by default on the decoder. Breaking: a payload of more than 1000 parts is refused unless maxParts is raised. Breaking: a part header line that is neither name: value nor a folded continuation is refused as header-malformed where it used to be skipped, and a boundary that never occurs is reported as truncated.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.1 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.2.0 - 2026-08-16
### Added
* New module. Multipart.Encoder combines an ordered list of parts — a JSON document, a form field, a file — into one payload with boundary framing, and returns it with the media type to send it under, because the generated boundary must appear in both and a hand-written header cannot carry it. Part content may be text, bytes or a byte stream, and a streamed part is written through rather than buffered. Multipart.Decoder is the inbound half, reading the boundary from the media type the sender supplied. form-data, related and mixed are one framing under different media types. Multipart.Reader is the incremental counterpart to Decoder — a stream of parts, each a stream of bytes — for uploads too large to hold whole; advancing past a part discards its remainder — for a partial read as well as a skipped one, since the drain runs on the reader's own source rather than on the stream the consumer holds — so stopping early is safe rather than a silent misread.
