# The code API

`@telorun/http-signature`, reached through the module's `exports.code`. Every function takes a plain **request description** and imports no transport:

```ts
interface RequestDescription {
  method: string;                 // "POST"
  targetUri: string;              // absolute, the query exactly as received
  headers: Record<string, string | string[] | undefined>;  // names in any case
  body?: Uint8Array | null;       // the verified bytes; absent reads as empty
}
```

| Function | Answers |
| --- | --- |
| `readMessageSignature(request, { label?, components, verifyContentDigest? })` | A `SignatureReading` for an RFC 9421 signature. With `verifyContentDigest: true`, a signature covering `content-digest` has that field checked against `request.body` (a mismatch is `malformed`); without it a covered `content-digest` is only a line of the signature base and the body stays unauthenticated. A caller sets it exactly when it supplies the body. |
| `readBodySignature(request, { signature, timestamp?, base })` | A `SignatureReading` for a webhook signature. |
| `requiredComponentId(text)` | Validates one `components` entry and answers its canonical identifier; throws on a malformed or unsupported one, so a source can refuse it at creation. |
| `compilePattern(pattern)` | Compiles an RE2 pattern with at least one group; throws otherwise. |
| `evaluateBaseParts(parts, { headers, body })`, `buildSignatureBase`, `verifyContentDigest(field, body)`, `parseSignatureInput`, `parseSignatures`, `parseDictionary` | The pieces, for callers that need one. |

A `SignatureReading` is `{ status: "absent" }` (no credential), `{ status: "malformed", reason }` (present and unreadable; the reason never repeats the value) or `{ status: "ok", presentation }`, the `Auth.SignaturePresentation` — `type`, `base`, `signatures`, `keyId`, `algorithm`, `created`, `expires`, with timestamps as CEL timestamps — ready to hand to a verifier. Anything else a function throws is a defect of the caller's configuration, not of the request.
