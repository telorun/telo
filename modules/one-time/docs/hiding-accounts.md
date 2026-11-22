# Hiding whether an account exists

A sign-in or reset page that answers differently for an address with an account and one without tells an attacker which addresses are registered. To answer alike:

1. Call `OneTime.Issue` for **every** subject you are asked about, account or not.
2. Send the message only when the account exists.
3. Answer the caller independently of the account.

Because every subject then holds a token, `holderMismatch`, `mismatch`, `exhausted` and `issued: false` reveal nothing: they happen identically for a real and a made-up subject. A redemption for a subject nobody asked a token for is `unknown`, which is also what an expired or used token is.

```yaml
steps:
  - name: issue
    invoke: { kind: OneTime.Issue, tokens: !ref signInCodes }
    inputs: { subject: !cel "inputs.email", holder: !cel "inputs.browserId" }
  - name: send
    if: !cel "steps.issue.result.issued && inputs.accountExists"
    then:
      - name: mail
        invoke: !ref mailer
        inputs: { body: !interpolate "code: ${{ steps.issue.result.?token.orValue('') }}" }
```

## The timing channel

The answer is the same but the time may not be: sending mail takes longer than not sending it. If the request waits for the mail, a caller measures the difference and learns which addresses are real. Send in the background (enqueue the message and answer at once), or make both branches wait alike. The same holds for the lookup that decides `accountExists`.
