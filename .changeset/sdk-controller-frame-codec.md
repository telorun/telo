---
"@telorun/sdk": minor
---

The frame of the controller protocol's framed carrier is a public export: `encodeFrame` / `decodeFrame` for one frame and `FrameReader` for a byte stream arriving in arbitrary chunks, with `Frame`, `FrameRefusal` and `MAX_FRAME_LENGTH` (16 MiB, refused from the length prefix alone). A refusal is terminal for the reader, as the protocol requires. The codec knows the frame, not the envelope in its meta, so any carrier speaking the framing (the desktop-host control channel among them) builds its own envelope with `encodeTypedFrame` / `decodeTypedFrame`.
