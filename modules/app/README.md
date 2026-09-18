# App

Run another Telo application as a resource of this one. `App.Instance` starts the application at `source`, supplies its declared inputs by name, reports its exit code as observed state, and shuts it down when the scope that declared it ends.

## Why use this

- **Applications cannot be imported** — an application is a root, run directly. Running one is how a manifest reaches another manifest, and it is the only way to test the file a user actually copies.
- **Supervise several as one** — three copies of the same application, each with its own identity and port, declared in one file and started together.
- **Test a server without restructuring it** — declare the child in a `Run.Sequence`'s `with:` block; it is listening before the first step and gone after the last one, so the port is free again and the run exits on its own.
- **Inputs by name, checked by the child** — you supply `variables` / `secrets` / `ports` under the names the child declares, never the environment variables it binds them to. A name it does not declare is refused.

## Kinds

| Kind | Purpose |
| --- | --- |
| `App.Instance` | Another application, started when this resource runs and stopped when its scope ends. |

## Example

```yaml
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: api }
    source: ../telo.yaml
    ports:
      http: 8931
targets:
  - !ref api
steps:
  - name: call
    invoke:
      kind: HttpClient.Request
      url: http://127.0.0.1:8931/v1/echo?say=hello
      method: GET
```

## Reference

- [`App.Instance`](docs/instance.md)
