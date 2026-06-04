# S3

Read and write objects in an S3-compatible bucket from a Telo manifest. Targets AWS S3 today; the same kinds work against any S3-API-compatible backend (MinIO, R2, etc.) given the right endpoint.

## Why use this

- **Declarative bucket binding** — `S3.Bucket` carries credentials and endpoint config once; every `Get`/`Put`/`List` references it by name.
- **Stream-friendly** — `S3.Put` accepts byte streams (codecs compose), so large uploads don't buffer in memory.
- **Listing as a first-class operation** — `S3.List` returns paginated keys for iteration in `Run.Sequence`.
- **Provider-agnostic** — point `S3.Bucket` at any S3-API endpoint and the rest of the manifest doesn't change.

## Kinds

| Kind | Purpose |
| --- | --- |
| `S3.Bucket` | Declare an S3 bucket (endpoint, region, credentials). |
| `S3.Put` | Upload bytes or a stream to a key. |
| `S3.Get` | Fetch an object's bytes by key. |
| `S3.List` | List keys under a prefix. |
| `S3.Delete` | Remove an object by key (idempotent). |

## Example

```yaml
kind: Telo.Application
metadata: { name: s3-app, version: 1.0.0 }
imports:
  S3: std/s3@latest
---
kind: S3.Bucket
metadata: { name: Uploads }
name: my-uploads
region: us-east-1
---
kind: S3.Put
metadata: { name: SaveReport }
bucket: { kind: S3.Bucket, name: Uploads }
key: reports/today.json
body: !cel "resources.GenerateReport.bytes"
```

## Reference

- [`S3.Bucket`](docs/bucket.md)
- [`S3.Put`](docs/put.md)
- [`S3.Get`](docs/get.md)
- [`S3.List`](docs/list.md)
- [`S3.Delete`](docs/delete.md)
