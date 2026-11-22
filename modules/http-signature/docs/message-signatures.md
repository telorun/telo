# RFC 9421 message signatures

A signed HTTP message carries two structured fields (RFC 9651): `Signature-Input`, a dictionary of labelled inner lists naming the covered components with signature parameters, and `Signature`, a dictionary of the same labels to byte sequences.

```
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1618884473;keyid="partner";alg="ed25519"
Signature: sig1=:2eL6VfF0kB3S…:
```

## Which signature is read

The one named by the `label` option. With none, the request must carry exactly one signature, otherwise it is malformed. A request with no `Signature` header, or none under the label, carries no credential; a `Signature` without a `Signature-Input`, or a label missing from it, is malformed.

## Coverage

The caller lists the components the signature **must** cover; it may cover more. They are derived components — `@method`, `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`, `@query`, `@query-param;name="x"` — and lower-case header field names. A signature covering less than required is malformed, and `components` is exactly what is authenticated: without `content-digest` the body is not.

Component parameters `sf`, `bs`, `key`, `req` and `tr`, `@status` and `@signature-params` are not supported; a signature that covers one is malformed. A `@query-param` whose name appears not exactly once in the query is malformed. A covered header the request lacks is malformed. Repeated header fields are joined with `, ` and surrounding whitespace is trimmed.

## The signature base

Built as RFC 9421 §2.5 specifies, from the request description's `method` and `targetUri`: one `"<component>": <value>` line per covered component, then `"@signature-params": <the inner list with its parameters, re-serialized>`, joined with newlines and no trailing one. `@scheme`, `@authority` and `@target-uri` come from the target URI, so a receiver behind a TLS-terminating proxy must hand over the externally visible URI, or every signature fails.

## Presentation members

`keyId` is the `keyid` parameter, `algorithm` the `alg` parameter, `created` and `expires` the integer-second parameters as timestamps. A parameter of the wrong type is malformed; `nonce` and `tag` are not read.

## Content-Digest

When the signature covers `content-digest`, the field (RFC 9530) is checked against the body, an absent body being the empty one. Every `sha-256` or `sha-512` digest it lists must match, compared in constant time; a field listing none of those, or one that does not parse, is malformed too.
