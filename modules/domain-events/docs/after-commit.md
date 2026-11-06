# Work after commit

Delivery is synchronous, so a handler runs before the emitter's transaction commits. Work that must happen after commit and survive a crash (a welcome email) is a handler that enqueues on a `queue-sql` outbox in the same transaction; a worker drains the queue after commit.

```yaml
kind: Domain.Handler
metadata: { name: queueWelcomeEmail }
event: !ref Iam.UserCreated
when: !cel "!event.email.endsWith('@example.com')"
invoke:
  kind: QueueSql.Enqueue
  queue:
    kind: QueueSqlite.Queue
    connection: !ref db
    schema: !ref appSchema
    table: !ref messages
    name: welcome_emails
    retention: 168h
    messageType:
      kind: Telo.JsonSchema
      schema:
        type: object
        required: [email]
        properties:
          email: { type: string }
inputs:
  id: !interpolate "welcome-${{ event.userId }}"
  message: { email: !cel "event.email" }
```

`QueueSql.Enqueue` requires a `Sql.Transaction` on its queue's connection. The requirement travels through the emit, so it is proven inside the emitter's transaction — here the library's own, opened on the connection the application lends it (`Iam: { source: ./iam, resources: { connection: !ref db } }`), which is `db` itself — and the same handler on an event that is also emitted outside a transaction is `ZONE_REQUIREMENT_UNSATISFIED`, naming the path through the emit. If the transaction rolls back, the message is never stored.

A handler publishing on a `broadcast-postgres` channel likewise delivers at commit.
