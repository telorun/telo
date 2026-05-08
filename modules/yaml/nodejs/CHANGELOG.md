# @telorun/yaml

## 0.2.0

### Minor Changes

- 019c62a: Initial release of the `yaml` module.

  Adds `Yaml.Parse` (`Telo.Invocable`): UTF-8 YAML string → `{ docs: object[] }`.
  Multi-document files are handled natively; single-doc callers read `docs[0]`.
  Malformed input throws `InvokeError("ERR_PARSE_FAILED")` carrying the parser
  error list on `error.data.errors`.

  `Yaml.Parse` is a plain `Telo.Invocable`, not a `Codec.Decoder` — YAML parsing
  needs the whole document up front, so the stream-oriented codec abstracts add
  nothing here. `Yaml.Stringify` (object → string) lands when the first consumer
  needs it.

  Primary use case: extracting metadata from a published manifest in handler
  code (e.g. the registry's publish endpoint reading `metadata.description`
  off the `Telo.Library` doc to populate its index).
