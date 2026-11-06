---
description: "The PostgreSQL engine of the SQL API-key store: the table and store kinds, what they create, and how instants and concurrency behave on PostgreSQL."
sidebar_label: API keys — PostgreSQL
---

# `ApiKeyPostgres`

> Examples assume this module is imported under alias `Keys`, `api-key-sql` under `ApiKeySql` and `postgres` under `PostgreSQL`.

What a store guarantees, retention, the sweep and atomicity are [`api-key-sql`'s](../../api-key-sql/docs/sql-store.md); this page is what is particular to PostgreSQL.

## Kinds

- **`Keys.Table`** — a `PostgreSQL.Table` the author writes one field of: `table`, the physical name. List it in the `PostgreSQL.Schema` that creates and migrates it; the module issues no DDL. Several stores may share one table.
- **`Keys.Store`** — `connection` (a `PostgreSQL.Connection`), `schema` (the `PostgreSQL.Schema` listing the table), `table` (a `Keys.Table`; a plain `PostgreSQL.Table` is `REFERENCE_KIND_MISMATCH`) and the abstract's `name`, `retention`, `prefix`, `scopes` and `maxLifetime`. It is a provider: nothing runs at boot, and its sweep starts at its first call.

## What exists in the database

| Object | Definition |
| --- | --- |
| columns `store_name`, `key_id`, `digest`, `owner_type`, `owner_id`, `scopes` | `text`, not null |
| columns `label`, `revoked_by`, `rotated_from` | `text`, nullable |
| column `created_at` | `timestamptz`, not null |
| columns `expires_at`, `revoked_at`, `last_used_at`, `ends_at` | `timestamptz`, nullable |
| index `api_key_<table>_id` | unique on (`store_name`, `key_id`) |
| index `api_key_<table>_owner` | on (`store_name`, `owner_type`, `owner_id`, `key_id`) |
| index `api_key_<table>_ends` | on (`store_name`, `ends_at`) |

The layout is internal to `api-key-sql` and changes only through the schema's migrations.

## Instants

Every instant is the database's clock, written through the schema's instant members, to microseconds.

## Concurrency

A rotation takes the old key's row, so a concurrent revoke or rotation of the same key waits for it. The sweep's batches select with `FOR UPDATE SKIP LOCKED`, so any number of processes sweep one table without waiting on each other or on a caller's transaction.

## Two stores, one name

The table kind declares `API_KEY_STORE_NAME_DUPLICATE`: two stores naming one `Keys.Table` with one `name` are both reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to start is refused with `ERR_API_KEY_STORE_NAME_DUPLICATE`.

## Runtime requirement

`requires: telo: ">=0.129.0"`: the table kind's rule binds `coReferrers:`, which an older analyzer evaluates unbound and reports as a defect in this module.
