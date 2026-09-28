# Detection rules

A `SecretScan.Detector` instance holds `rules`, a non-empty list. Each rule has a `name` — reported as the finding's `rule` — and exactly one of `token`, `marker` or `entropy`. Rules report independently: one secret can be reported by several rules at the same position (an `sk-` key long and random enough to trip the entropy rule is reported by both).

Calling an instance with `text` returns a list of `{ rule, line, column }`, ordered by position and then by the order of the rules. `line` and `column` are 1-based and point at the first character of the match; a column counts characters, not bytes. The matched text is never part of the result.

## Charsets

| `charset` | Characters | Most bits per character |
| --- | --- | --- |
| `alphanumeric` | `A–Z a–z 0–9` | log2(62) ≈ 5.954 |
| `upperAlphanumeric` | `A–Z 0–9` | log2(36) ≈ 5.170 |
| `hex` | `0–9 a–f A–F` | 4 |
| `base64` | `A–Z a–z 0–9 + /`, with `=` padding | 6 |
| `base64url` | `A–Z a–z 0–9 _ -` | 6 |

## `token` — a known prefix

```yaml
- name: awsAccessKeyId
  token: { prefixes: [ AKIA, ASIA ], charset: upperAlphanumeric, minLength: 16, maxLength: 16 }
```

A match is one of the `prefixes` followed by a run of `charset` characters whose length is at least `minLength` and, when `maxLength` is given, at most `maxLength`.

- **The length is the length of the part after the prefix**: the maximal run of `charset` characters that directly follows the prefix. `AKIA` plus sixteen upper-case letters and digits is a 20-character key whose length here is 16. A run longer than `maxLength` is not a match — it is some other token.
- **A prefix starts a word.** It matches at the start of the text or after a character that is not a letter, digit, `_` or `-`, so the `sk-` inside `task-management` is not a candidate.
- The finding points at the prefix.

## `marker` — a literal

```yaml
- name: privateKey
  marker: { text: "PRIVATE KEY-----" }
```

Every occurrence of `text` is a finding, pointing at its first character.

## `entropy` — a random-looking run

```yaml
- name: highEntropyToken
  entropy:
    charset: base64url
    minLength: 24
    minBitsPerChar: 4.4
    except: [ sha256-, sha384-, sha512-, "sha256:", "sha512:" ]
```

A candidate is every maximal run of `charset` characters at least `minLength` long. Its entropy is the Shannon entropy of the run's own character frequencies, in bits per character: `−Σ p·log2(p)` over the distinct characters, `p` being a character's share of the run. A candidate at or above `minBitsPerChar` is a finding, pointing at its first character.

A candidate that **starts with** one of the `except` literals, or **directly follows** one, is exempt. That is how content digests stay out: an integrity pin `…@0.33.0#sha256-KuqD…` is a base64url run beginning `sha256-`, and `sha512:z4gq…` is a run directly after `sha512:`.

## Refused rule sets

A rule set that can never match as written is refused by `telo check` at the declaration and by the controller when the instance is created (`ERR_SECRET_SCAN_RULES_INVALID`, whose message and `data.problems` name each rule by the code below):

| Code | Rule |
| --- | --- |
| `SECRET_SCAN_PREFIXES_EMPTY` | a `token` rule lists no `prefixes` |
| `SECRET_SCAN_LENGTH_RANGE_EMPTY` | a `token` rule's `maxLength` is below its `minLength` |
| `SECRET_SCAN_ENTROPY_UNREACHABLE` | an `entropy` rule's `minBitsPerChar` exceeds its charset's most bits per character (the table above) |

## The standard set: `credentialFindings`

| Rule | Shape |
| --- | --- |
| `openaiKey` | `sk-` + ≥ 20 base64url |
| `awsAccessKeyId` | `AKIA` / `ASIA` + exactly 16 upper-case alphanumerics |
| `githubToken` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` + ≥ 36 alphanumerics |
| `githubFineGrainedToken` | `github_pat_` + ≥ 22 alphanumerics |
| `googleApiKey` | `AIza` + exactly 35 base64url |
| `slackToken` | `xoxb-` `xoxp-` `xoxa-` `xoxr-` `xoxs-` + ≥ 10 base64url |
| `stripeKey` | `sk_live_` / `rk_live_` + ≥ 24 alphanumerics |
| `privateKey` | the marker `PRIVATE KEY-----` (any PEM private key header) |
| `highEntropyToken` | base64url runs of ≥ 24 characters at ≥ 4.4 bits per character, digests excepted |

### Why 24 characters and 4.4 bits

The entropy rule is the backstop for credentials no prefix names, so it has to trip on a typical API key and stay silent on manifest text. The threshold was chosen by measurement:

- **Manifest text.** Every `*.yaml`, `*.yml` and `*.md` file in the Telo repository (2,054 files: manifests, fixtures, docs) was scanned. At 24 / 4.4 no run trips outside three files that embed genuinely random data — a base64-encoded PDF fixture, base64 SSE payloads and the package lockfile's integrity hashes. The highest-scoring ordinary text found was a 35-character PascalCase resource name at 4.31 bits and date-stamped migration names at 4.33–4.36; at 4.3 those trip, which is why the threshold is above them. Kind names, URLs and CEL never form a long run, because `.`, `/`, `(` and quotes break it.
- **UUIDs and hex digests never trip.** A UUID is hex plus dashes and a hex digest is at most 4 bits per character, below any threshold over 4. The flip side is that a secret written in hex is not caught by this rule — only by a prefix rule naming it.
- **API keys.** Random alphanumeric strings trip at: 32 characters 86%, 40 characters 99.7%, 48 characters 100% (2,000 samples each). A 24-character random string trips 17% of the time: short secrets are what the prefix rules are for.
