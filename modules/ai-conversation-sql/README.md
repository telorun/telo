# AI Conversation — SQL

`AiConversationSql.Store` keeps [`ai-conversation`](https://hub.telo.run/module/oci/ghcr.io/telorun/ai-conversation/) conversations in tables on a database you already run (PostgreSQL or SQLite), written against `Sql.Connection` without branching on the engine.

## Why use this

- **It owns its tables** — five tables under a `tablePrefix`, created on start. Their layout version is recorded and older layouts are upgraded in place; a layout newer than the module understands is refused before anything is touched.
- **Fenced writes in one transaction** — an append locks the conversation's header row while checking the turn, so a superseded turn never writes and two writers never get the same sequence.
- **Bounded paging** — a branch page is one recursive statement walking parent links from the resume point; sibling facts come from one index.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `AiConversationSql.Store` | Provider | `connection`, `tablePrefix` (default `ai_conversation_`), `createTables` (default `true`). |

Tables, schema versions and trade-offs: [store layout](./docs/store-layout.md).

## Example

```yaml
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: AiConversationSql.Store
metadata: { name: store }
connection: !ref db
```
