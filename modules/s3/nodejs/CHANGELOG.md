# @telorun/s3

## 1.0.8

### Patch Changes

- dccd3a6: Removed leftover debug `console.log` calls from `S3.List` controller (`invoke` and pre-`ListObjectsCommand` traces).
- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 1.0.7

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 1.0.6

### Patch Changes

- f061c35: `S3.Bucket` with `createIfMissing: true` now issues a `HeadBucketCommand` first and only calls `CreateBucketCommand` when the head returns 404. This avoids the spurious create-then-catch round trip against providers that log "bucket exists" attempts loudly (R2, MinIO). The existing `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` catch is kept as a guard against a head-vs-create race.

## 1.0.5

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 1.0.4

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 1.0.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 1.0.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 1.0.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6
