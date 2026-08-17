# Money transfer — a write that cannot escape its transaction

Two accounts, one `POST /transfers`. The balance check, the debit and the credit
all happen inside one `Sql.Transaction`, so nobody can spend the same money
twice between the check and the write.

```sh
telo ./examples/money-transfer

curl -s localhost:8055/accounts
curl -s -XPOST localhost:8055/transfers -H 'content-type: application/json' \
  -d '{"from":1,"to":2,"amountCents":2500}'
curl -s -XPOST localhost:8055/transfers -H 'content-type: application/json' \
  -d '{"from":1,"to":2,"amountCents":999999}'   # 409 — and no balance moved
```

## The part that is not just "we have transactions"

`moveMoney` is declared with `transaction:` rather than `connection:`:

```yaml
kind: Sql.Command
metadata: { name: moveMoney }
transaction: !ref transferTx
```

`Sql.Command`'s schema marks that slot `x-telo-requires-zone`, and
`Sql.Transaction`'s `steps:` slot marks itself `x-telo-provides-zone`. Together
they say: *this statement is reachable only through that transaction's body*.
The analyzer walks the call graph and enforces it.

[`broken.yaml`](broken.yaml) is the same app with one extra caller that invokes
the statement directly. It never runs:

```
$ telo check ./examples/money-transfer/broken.yaml
error  Sql.Command 'moveMoney' requires a SQL.Transaction zone on
       SQLite.Connection 'db', and the path
       moveMoney → payout → MoneyTransferBroken.targets[0]
       reaches the application's boot targets, which nothing encloses.
       the statement would execute outside any transaction.
       ZONE_REQUIREMENT_UNSATISFIED
```

The diagnostic names the path, not just the resource — which is the difference
between a rule and a usable rule. This class of bug (a write that is
transactional on the path you tested and not on the one you didn't) is normally
found in production; here it is found by `telo check`, and it works the same way
for any kind that declares a zone, not just SQL.

## Why the decline is a return value, not a throw

An overdraft answers `declined: true` and the transaction commits having written
nothing, so the route renders 409 from `when: !cel "result.declined"`. A throw
would work too — anything raised inside the body rolls the transaction back —
but a declined transfer is an expected outcome, not a failure, and modelling it
as data keeps it visible in the route's `returns:` where a reader can see the
409 without chasing an error code.
