# Auth

The shared vocabulary of inbound authentication and authorization. It declares no transport and imports nothing: every module that authenticates a request, verifies a credential or decides an action imports it, so they agree on one caller and one credential shape.

## Kinds and shapes

| Name | What it is |
| --- | --- |
| `Auth.Principal` | The authenticated caller. See [principal](./docs/principal.md). |
| `Auth.Presentation` | The credential material, by what it is: `token`, `basic`, `certificate` or `asserted`. Variants are exported separately as `Auth.TokenPresentation`, `Auth.BasicPresentation`, `Auth.CertificatePresentation` and `Auth.AssertedPresentation`. See [presentations](./docs/presentations.md). |
| `Auth.Confirmation` | Proof of possession the transport builds: a client-certificate thumbprint and a DPoP proof. |
| `Auth.VerifierOutput` | A verifier's answer: `{ principal }` or `{ refused, reason, challenge }`. |
| `Auth.Verifier` | Abstract. `{ presentation, confirmation, resource }` → `Auth.VerifierOutput`. Its reading publishes `challenges`, and `issuer` when the kind declares one. See [verifiers](./docs/verifiers.md). |
| `Auth.PasswordVerifier` | Abstract. `{ identifier, password }` → `{ principal }` or `{ refused, reason: unknown \| mismatch \| disabled \| throttled }`. It is not an `Auth.Verifier`. |
| `Auth.Policy` | Abstract. `{ principal, action, resource, context }` → `{ allow, reason?, requiredScopes? }`. |
| `Auth.TrustedHeader` | An `Auth.Verifier` accepting only `asserted` presentations from a trusted reverse proxy. |

`Auth.PasswordOutput` and `Auth.PolicyDecision` are the exported shapes of the two other contracts' answers.

```yaml
imports:
  Auth: oci://ghcr.io/telorun/auth@<version>
---
kind: Auth.TrustedHeader
metadata: { name: gateway }
principalIssuer: https://sso.example.com
claimNames: { roles: groups }
```

## Using the shapes from another module

A shape is a `Telo.JsonSchema` resource the library exports. Name it from an importing module as `!ref Auth.Principal` wherever a schema belongs (a contract, a property, `items`), or as `$ref: "telo://Auth/Principal"` inside a kind's `schema:` or an `x-telo-context` (the authority is the import alias).

Docs: [principal](./docs/principal.md) · [presentations](./docs/presentations.md) · [verifiers](./docs/verifiers.md) · [trusted header](./docs/trusted-header.md)
