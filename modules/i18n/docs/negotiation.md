# Answering in the caller's language

> Examples assume this module is imported under the alias `I18n`.

## `I18n.Negotiator`

A CEL function choosing the language to answer in, from a translator's catalog languages and a default:

```yaml
kind: I18n.Negotiator
metadata: { name: language }
translator: !ref t
default: en
```

| Field | Meaning |
| --- | --- |
| `translator` | The translator whose catalog languages a caller may be answered in. |
| `default` | The language the module's texts are written in — answered when nothing else matches. |

Called with an `Accept-Language` value, it answers a language tag:

```yaml
!cel "Self.language('de;q=0.9, pl;q=0.8')"     # pl, with pl and en catalogs
!cel "Self.language('en;q=1, pl;q=0.5')"       # en, the default, with only a pl catalog
```

1. The ranges are read leniently, because the value comes from a client: a malformed range or quality is skipped, `*` is skipped, and a range of quality `0` is dropped.
2. The rest are tried by quality, highest first, written order breaking ties.
3. Each range is matched by RFC 4647 lookup against the catalog languages, in the order the translator lists its catalogs, and then the default: the range, then each shorter variant (`pl-PL` → `pl`), compared without regard to case. The first match is answered as the catalog wrote it.
4. When no range matches — or the value is empty — the default is answered.

## An API answering in the caller's language

Negotiate once per request, pass the tag to every translation, and say which language the answer is in:

```yaml
kind: Http.Api
metadata: { name: api }
routes:
  - request:
      method: GET
      path: /rates/{user}
    inputs:
      user: !cel "request.params.user"
      lang: !cel "Self.language(request.headers[?'accept-language'].orValue(''))"
    handler:
      kind: Run.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [user, lang]
          properties:
            user: { type: string }
            lang: { type: string }
      steps:
        - name: message
          value: !cel "Self.t('Rate not found for {$user}', inputs.lang, {'user': inputs.user})"
      outputs:
        lang: !cel "inputs.lang"
        message: !cel "steps.message.result"
    returns:
      - status: 404
        headers:
          Content-Language: !cel "result.lang"
        content:
          application/json:
            body: { error: !cel "result.message" }
```

`Accept-Language: pl-PL, en;q=0.5` answers `{"error": "Nie znaleziono stawki dla Ala"}` with `Content-Language: pl`.
