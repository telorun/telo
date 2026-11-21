# Secret seed conformance vectors

`secret-seed.json` is the executable form of the package README. Every implementation
(`@telorun/secret-seed` in Node, any later twin) loads it and must agree with each row.

- `decode` — `{ name, text, bytesHex }` must decode to exactly those 32 bytes, and re-encode to `text`;
  `{ name, text, refused: true }` must be refused.
- `derive` — `{ seed, label, child }`: the child derivation of the decoded `seed` under `label`
  (the label's UTF-8 bytes), encoded, equals `child`.
- `refusals` — the sentence refused with, for a variable named `TELO_HOST_SECRET_SEED` and for a file
  at `<path>` (the placeholder stands for the path the implementation was given). The value is never in it.

File behaviour (create, read, never overwrite) is stated in the README and tested by each implementation
against a temporary directory; it has no vectors because it touches a filesystem.
