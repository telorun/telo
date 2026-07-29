# Flows

Four ways to obtain a grant. They share the same `AuthorizationServer`, `Client`
and `TokenSource`, and all end with a grant in the store — so everything
downstream (`AccessToken`, `Credential`, `GrantRead`) works the same regardless of
how the grant was obtained.

| Situation | Use |
| --- | --- |
| A terminal program on a machine with a browser | Loopback sign-in |
| A web application serving many users | Browser-served callback |
| A TV, a CLI on a headless box, an SSH session | Device grant |
| No user at all — service to service | Client credentials |

## Loopback sign-in (terminal)

The program binds a socket on `127.0.0.1`, prints a URL, and waits. The browser
comes back to that socket. RFC 8252 puts native applications here deliberately.

`RedirectListener` is a `Telo.Service` declared in a `Run.Sequence`'s `with:`
block and listed in its `targets:`. That ordering matters: `targets:` run before
the steps, so the socket is bound — and already accepting — before the consent
URL is built. The port it got is reported as observed state:

```yaml
inputs:
  redirectUri: !cel "resources.Loopback.status.redirectUri"
```

The port is chosen by the operating system by default. A sign-in is not a
service, so it should not claim a port a real listener wants, nor fail because
another instance is already running. Providers that follow RFC 8252 accept any
loopback port. For one that demands an exactly-registered redirect URI, pin it:

```yaml
- kind: OAuth.RedirectListener
  metadata: { name: Loopback }
  port: 45678
```

`RedirectListener` and `RedirectAwait` are two kinds because a `targets:` entry
takes a Runnable or Service and a step's `invoke:` takes an Invocable — no single
capability satisfies both slots.

### Paste-the-code variant

Drop the listener and the await, print the URL, and read the code from the
terminal with `Console.ReadLine`. The exchange is identical; pass the
`redirectUri` the provider requires for out-of-band flows.

## Browser-served callback

The redirect arrives as a *separate* HTTP request that shares no `steps.*` scope
with the one that built the consent URL — possibly not even the same instance. The
two halves are joined by a declared reference: `Callback` holds an
`authorization: !ref`, and reads the store, client and key space through it. There
is no way to point the two at different stores.

```yaml
kind: OAuth.Callback
metadata: { name: OAuthCallback }
authorization: !ref Authorize
---
kind: Http.Api
metadata: { name: OAuthRoutes }
routes:
  - operationId: oauthCallback
    request:
      method: GET
      path: /callback
      schema:
        query:
          type: object
          properties:
            code: { type: string }
            state: { type: string }
            error: { type: string }
    inputs:
      code: !cel "request.query.code"
      state: !cel "request.query.state"
      error: !cel "request.query.error"
    handler: !ref OAuthCallback
    returns:
      - when: !cel "result.ok"
        status: 200
        content:
          text/html:
            body: !cel "'<p>Signed in. You can close this tab.</p>'"
      - when: !cel "!result.ok"
        status: 400
        content:
          text/html:
            body: !cel "'<p>Sign-in failed: ' + result.reason + '</p>'"
```

The module ships no HTML and no request parsing — the route already maps
`request.query` in and renders `returns:` out, so the page is yours: branding,
localization, or a redirect somewhere else entirely.

A refusal, an unrecognized `state` and an expired request are **returned
outcomes**, not exceptions: they are legitimate ends of the flow that the response
has to render. `result.reason` is `denied`, `unknown_state`, `expired`,
`issuer_mismatch` or `issuer_missing`, and `returns[].when` selects on it with
`result` statically typed. A genuine failure — a token endpoint 5xx, a malformed
response — still throws.

`expired` is distinct from `unknown_state`: a pending request outlives its own
deadline in storage for a while precisely so a user who took too long is told that,
rather than being told their sign-in never existed.

Starting a sign-in for a specific user means passing the key:

```yaml
- name: begin
  invoke: !ref Authorize
  inputs:
    redirectUri: https://app.example.com/callback
    key: !cel "'user/' + request.params.userId"
```

## Device grant

For a machine with no browser. `DeviceAuthorization` returns a short code and a
URL for the user to open elsewhere; `DeviceToken` polls until they finish.

```yaml
- name: start
  invoke: !ref StartDevice
- invoke: !ref Console.writeLine
  inputs:
    output: !cel "'Go to ' + steps.start.result.verificationUri + ' and enter ' + steps.start.result.userCode"
- name: approved
  invoke: !ref AwaitDevice
  inputs:
    deviceCode: !cel "steps.start.result.deviceCode"
    interval: !cel "steps.start.result.interval"
    expiresAt: !cel "steps.start.result.expiresAt"
```

Polling honours the server's requested interval and backs off when it asks to slow
down. A refusal or an expired code comes back as `{ ok: false, reason: … }` rather
than throwing.

## Client credentials

No user, no consent, no refresh token — the application authenticates as itself.
The result is stored as an ordinary grant, so `AccessToken` and `Credential` serve
it unchanged. When it expires, `AccessToken` obtains a new one the same way.

```yaml
- invoke: !ref MachineGrant
  inputs: { key: service }
```

## What is deliberately absent

The resource-owner password grant. The specification deprecates it; adding it
would invite the worst available flow.
