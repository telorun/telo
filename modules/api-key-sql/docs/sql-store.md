---
description: "The SQL API-key store: how retention is judged on every read, when and how the background sweep deletes ended keys, which operations are atomic, and what the key table holds."
sidebar_label: API keys — SQL store
---

# `ApiKeySql`

> Examples assume this module is imported under alias `ApiKeySql`, `api-key` under `ApiKey` and an engine module (`api-key-postgres` or `api-key-sqlite`) under `Keys`.

A store implements the interface in [`api-key`'s store contract](../../api-key/docs/store-contract.md) over one table. It stores and answers outcomes; the operations and the verifier own every error code, the key format and the digest.

## `ApiKeySql.Store`

| Field | Purpose |
| --- | --- |
| `connection`, `schema`, `table` | Where the keys live, each narrowed to the engine's kinds by the engine module's `Store`. The `schema` lists the table; the store issues no DDL. |
| `name` | The store's durable identity inside its table, written into every row. Never derived from the resource name, so renaming the resource keeps its keys. |
| `retention` | How long a revoked or expired key is still found, to be reported as such. Positive (`0s` is a `SCHEMA_VIOLATION`). |
| `prefix`, `scopes`, `maxLifetime` | `ApiKey.Store`'s own. |

## Retention

A key **ends** when it is revoked or reaches its `expiresAt`, whichever is earlier. A key that ended more than `retention` ago is **unknown**: `lookup`, `touch`, `list`, `revoke` and `rotate` all answer `absent` or leave it out, so a revoked key shows as revoked in a listing and an attempt to rotate it is refused for `retention`, and is `ERR_API_KEY_NOT_FOUND` after.

Every statement the store issues judges this on the database's clock, so no answer depends on the sweep, and every replica forgets a key at the same moment.

## The sweep

The sweep only frees space. It deletes a store's ended keys older than `retention`:

- **In bounded batches** of 500 rows, at most twenty per pass, each batch in a short transaction of its own that skips rows another transaction holds.
- **Every `retention`**, clamped to between one second and one minute.
- **Never in a caller's transaction**, and holding nothing: a finished application is never kept alive by it.
- **A failed pass** is logged as a warning and the next pass tries again.

**It starts at the store's first call** — of any method — and not at boot. A store that is declared and never called issues no statement and starts no sweep; `init()` does no I/O. Teardown stops the sweep and waits for a pass in flight. A table written by a store that is never called again keeps its ended rows until a store of that name is called.

## Atomicity

- `touch` is one conditional write on the database's clock: it writes when the last use is empty or older than the resolution, so replicas write at most once per interval.
- `revoke` is one conditional write; repeating it keeps the first revocation.
- `rotate` runs in one transaction. The conditional update of the old key takes its row, so a revoke racing a rotation waits for it, and the successor and the old key's new expiry commit together or not at all.
- `list` pages by key id (creation time to the millisecond) from an index on the store, the owner and the id.

## What the table holds

Created by the engine module's `Table` kind; every column is internal. The key itself is never stored.

| Column | Holds |
| --- | --- |
| `store_name`, `key_id` | The store's `name` and the key's UUID; unique together. A lookup is one read on that index. |
| `digest` | SHA-256 of the whole key, base64url. |
| `owner_type`, `owner_id` | The owner. |
| `scopes` | The scopes as a JSON array. |
| `label` | The label, or null. |
| `created_at`, `expires_at`, `revoked_at`, `last_used_at` | Instants on the database's clock. |
| `revoked_by` | Who revoked it, or null. |
| `rotated_from` | The UUID of the key this one replaced. It is no foreign key, so sweeping a predecessor leaves its successor intact. |
| `ends_at` | The earlier of `revoked_at` and `expires_at`, kept by issue, revoke and rotate. Retention and the sweep read only this column. |

Indexes: unique on (`store_name`, `key_id`); on (`store_name`, `owner_type`, `owner_id`, `key_id`) for listing; on (`store_name`, `ends_at`) for retention and the sweep.

## Two stores, one name

Each engine's table kind declares `API_KEY_STORE_NAME_DUPLICATE`: two stores naming one table with one `name` are reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to start is refused with `ERR_API_KEY_STORE_NAME_DUPLICATE`. The rule is declared on the engine's table kind because a `base:`-form kind inherits no rule and has one parent, the engine's `Table`.

## Runtime requirement

`requires: telo: ">=0.129.0"`: the store reads the engine schema's `currentInstantPlus`, `instantParameter` and `skipLockedClause` members, and `retention` is a bounded `Telo.Duration`, both first in that release.
