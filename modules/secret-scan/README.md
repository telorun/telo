# Secret Scan

Find credentials in text before it is written to disk, committed, or sent somewhere it should not go. `SecretScan.Detector` is a CEL function kind: an instance holds a set of detection rules, and calling it on a string returns one `{ rule, line, column }` per finding — **never the matched text**, so the result is safe to log, return to a model, or show in an editor.

## Why use this

- **Callable from any CEL expression** — a guard step, a `when:`, a route's `inputs:` — as `SecretScan.credentialFindings(text)`, with a typed result `telo check` understands.
- **Three rule shapes** — a known token prefix with a length window (`sk-`, `AKIA`, `ghp_`), a literal marker (`PRIVATE KEY-----`), and a Shannon-entropy threshold for credentials no prefix names.
- **A ready-made standard set** — `credentialFindings` covers common provider keys and PEM private keys, and leaves content digests such as integrity pins alone.
- **Deterministic** — the same text and rules always give the same findings, so a call is allowed wherever a deterministic function is required.

## Kinds and instances

| Name | What it is |
| --- | --- |
| `SecretScan.Detector` | A function kind: configure `rules`, call with `text`, get findings. |
| `SecretScan.credentialFindings` | A ready-made detector with the standard rule set. |

## Example

Refuse to write a file whose content carries a credential:

```yaml
kind: Telo.Application
metadata: { name: Notes, version: 1.0.0 }
imports:
  SecretScan: oci://ghcr.io/telorun/secret-scan@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref save
---
kind: Run.Sequence
metadata: { name: save }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      content: { type: string }
steps:
  - name: findings
    value: !cel "SecretScan.credentialFindings(inputs.content)"
  - name: refuse
    if: !cel "size(steps.findings.result) > 0"
    then:
      - name: raise
        throw:
          code: ERR_SECRET_IN_CONTENT
          message: !cel >-
            'content holds a credential at ' + steps.findings.result
              .map(f, 'line ' + string(f.line) + ' (' + f.rule + ')').join(', ')
```

## Reference

- [Detection rules](docs/detection-rules.md) — the three rule shapes, how a token's length and a run's entropy are measured, the standard set, and the evidence behind its entropy threshold.
