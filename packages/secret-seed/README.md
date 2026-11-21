# @telorun/secret-seed

The secret seed: 32 random bytes from which a Telo host derives the generated secrets of the applications it runs. This package is the one implementation of its encoding, its refusals, its file and its derivation; it names no host vocabulary, so each host attaches its own error code to a refusal. This README is the normative spec, and `conformance/` holds the vectors every implementation must meet.

## Encoding

A seed is exactly 32 bytes, written as **unpadded base64url** (RFC 4648 §5): 43 characters from `A-Z a-z 0-9 - _`, the last carrying two spare bits that must be zero. Anything else is refused: another length, padding (`=`), the standard alphabet (`+`, `/`), non-zero spare bits, whitespace. A seed text is compared as given; a caller that reads a file removes the one trailing newline the file holds (below), nothing more.

## Refusals

A refusal is a `SecretSeedError` whose message names its source and never the value:

- a variable: `<NAME> must be 32 bytes of unpadded base64url` (`TELO_HOST_SECRET_SEED must be 32 bytes of unpadded base64url`)
- a file: `<path> does not hold 32 bytes of unpadded base64url`

The error also carries `source`, `{ variable }` or `{ file }`, so a host can attach its own code (`ERR_NEED_HOST_VALUE_INVALID`, a runner's startup failure) without parsing the sentence.

## The `secret-seed` file

A host whose durable state root has a single writer keeps its seed in a file named `secret-seed` there. `readOrCreateSecretSeedFile(path)`:

- **Absent:** generates 32 random bytes, creates the file exclusively with mode `0600`, and returns the seed. The file holds the seed text followed by one `\n`. Parent directories are created. The content is written to a private temporary file beside it and hard-linked into place, so the creation is exclusive and a concurrent reader never sees the file empty; a writer that loses the race reads the winner's file and returns that seed. The temporary file is removed. On a filesystem without hard links the file is created exclusively in place instead.
- **Present:** reads it, before anything is written — a valid file in a directory the process cannot write is read as it is — accepting the seed text with or without one trailing `\n`, and returns the seed. A file that does not decode is refused naming its path. The file is **never** rewritten or regenerated, so a truncated file stays for the operator to look at.
- **Windows:** the mode has no effect; the file keeps the ACL it inherits from its directory, which the operator is expected to restrict to the account running the host.

Deleting the file, or supplying a different seed, changes every secret derived from it.

## Child seed

`deriveChildSeed(seed, label)` is HKDF-SHA256 (RFC 5869) over the 32-byte seed with an **empty salt**, the label's UTF-8 bytes as `info`, and 32 bytes of output. The same seed and label always give the same child, so a restart, a replica sharing the seed and a resumed session agree. The caller owns the label's composition and separators.

## API

- `decodeSecretSeed(text, source)` returns the 32 bytes or throws `SecretSeedError`.
- `encodeSecretSeed(seed)` returns the 43-character text.
- `generateSecretSeed()` returns 32 random bytes.
- `deriveChildSeed(seed, label)` returns the child seed's 32 bytes.
- `readOrCreateSecretSeedFile(path)` as above; `SECRET_SEED_FILE_NAME` is `secret-seed`.
- `refusalSentence(source)` returns the sentences above.
