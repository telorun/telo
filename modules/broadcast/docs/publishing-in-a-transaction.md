# Publishing in a transaction

Whether a publish joins a transaction is a property of the channel's backend, not
of `Broadcast.Publish`. `Publish` hands the backend the invocation's context; a
backend over a database with transactions finds the caller's open transaction
through it and delivers the message when that transaction commits, never when it
rolls back, and several publishes in one transaction arrive in call order. Outside
a transaction such a backend sends at once.

A backend with no transactions sends at once either way. `Broadcast.MemoryChannel`
is one: a message published inside a `Sql.Transaction` that later rolls back has
already reached the application's subscriptions, so it is for development, tests and
single-instance applications.

`Broadcast.Publish` is marked as not replayable: inside a durable run a replayed
step would send the message again, so `telo check` refuses the placement.

Publish a hint about a change after the change is made, and let the consumer read
the data from where it lives; a message is never the data itself.
