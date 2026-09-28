---
---

The Telo controller protocol is written down: `kernel/specs/controller-protocol.md` (the normative spec — the closed message set, the six transfer-semantics sections, the length-prefixed framed carrier pinned byte-exactly, generation `telo-4`) and `sdk/controller-protocol/` (the message set as data, one JSON file per message, plus `generation.json`). `pnpm run check:controller-protocol` asserts the spec's inventory table and the message directory agree in both directions. No published package's behaviour moves, and no artifact may declare `abi=telo-4` until the ABI carrier lands — `telorun-abi`'s `TELO_ABI_VERSION` stays `3`.
