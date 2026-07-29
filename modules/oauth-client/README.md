# OAuth Client

Delegated access for Telo applications: drive a user through consent, exchange the
resulting code for tokens, keep the grant, and use it — without writing the flow
by hand or asking anyone to paste a refresh token into an environment variable.

Provider-neutral. An authorization server is configured from its issuer URL alone;
Google, Okta, Auth0, Entra, Keycloak and anything else compliant differ only in
that URL and the scopes you ask for.

## Why use this

- **Every way in.** Terminal sign-in over a loopback socket, a browser-served
  callback route, a device grant for machines with no browser, and the
  machine-to-machine grant — all against the same client and grant store.
- **Nothing to remember at the call site.** Attach a credential to an
  `Http.Client` and every request through it is authenticated by construction,
  refreshed before expiry, and retried once with a fresh token if the server
  rejects it.
- **Safe by default.** PKCE is on, `iss` is verified against the declared issuer,
  a pending sign-in is single-use, and only one refresh per grant runs at a time
  so a rotated refresh token is never presented twice.
- **Many accounts, one resource.** Grants are addressed by key, supplied per
  call, so one token source serves every user of a web application.
- **Your storage.** Grants live in any `KvStore.Store`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `OAuthClient.AuthorizationServer` | The server being talked to, configured from its issuer; endpoints discovered on first use. |
| `OAuthClient.Client` | This application's registration there — id, secret, scopes, PKCE. |
| `OAuthClient.TokenSource` | Binds a registration to durable storage and a default grant key. |
| `OAuthClient.Authorization` | Builds the consent URL and records the pending request. |
| `OAuthClient.RedirectListener` | Loopback socket that receives the browser redirect for a terminal sign-in. |
| `OAuthClient.RedirectAwait` | Waits on that listener for the redirect to arrive. |
| `OAuthClient.Callback` | Completes a browser-served sign-in behind an `Http.Api` route. |
| `OAuthClient.TokenExchange` | Authorization code → tokens. |
| `OAuthClient.TokenRefresh` | Refresh token → tokens, stored. |
| `OAuthClient.ClientCredentials` | Machine-to-machine grant, no user present. |
| `OAuthClient.DeviceAuthorization` | Starts a device grant; returns the user code and URL. |
| `OAuthClient.DeviceToken` | Polls until the user approves, denies, or the code expires. |
| `OAuthClient.AccessToken` | A currently-valid access token, refreshed as needed. |
| `OAuthClient.GrantRead` | What is stored for a key — scopes, expiry, whether one exists. |
| `OAuthClient.GrantWrite` | Store a token set as the grant for a key. |
| `OAuthClient.GrantClear` | Remove the stored grant (local sign-out). |
| `OAuthClient.Credential` | `Http.Credential` implementation — authenticates an `Http.Client`. |

## Example

Sign in from a terminal, then call an API with the stored grant:

```yaml
kind: Telo.Application
metadata: { name: sheets-demo, version: 1.0.0 }
imports:
  OAuth: oci://ghcr.io/telorun/oauth-client@<version>
  Http: oci://ghcr.io/telorun/http-client@<version>
  Store: oci://ghcr.io/telorun/kv-store-sql@<version>
  Console: oci://ghcr.io/telorun/console@<version>
  Run: oci://ghcr.io/telorun/run@<version>
variables:
  clientId: { env: GOOGLE_CLIENT_ID, type: string }
secrets:
  clientSecret: { env: GOOGLE_CLIENT_SECRET, type: string }
targets: [ !ref Login ]
---
kind: OAuth.AuthorizationServer
metadata: { name: Google }
issuer: https://accounts.google.com      # endpoints discovered from here
---
kind: OAuth.Client
metadata: { name: App }
authorizationServer: !ref Google
clientId: !cel "variables.clientId"
clientSecret: !cel "secrets.clientSecret"
scopes: [ https://www.googleapis.com/auth/spreadsheets ]
authorizationParams:
  access_type: offline                   # what makes a refresh token come back
  prompt: consent
---
kind: OAuth.TokenSource
metadata: { name: Tokens }
client: !ref App
store: !ref GrantStore
---
kind: OAuth.Authorization
metadata: { name: Authorize }
source: !ref Tokens
---
kind: OAuth.TokenExchange
metadata: { name: Exchange }
source: !ref Tokens
---
kind: OAuth.GrantWrite
metadata: { name: SaveGrant }
source: !ref Tokens
---
# The listener is scoped to the sequence and started from `targets:`, so it is
# bound before the steps run and closed when they finish.
kind: Run.Sequence
metadata: { name: Login }
with:
  - kind: OAuth.RedirectListener
    metadata: { name: Loopback }
  - kind: OAuth.RedirectAwait
    metadata: { name: AwaitRedirect }
    listener: !ref Loopback
    timeout: 5m
targets:
  - !ref Loopback
steps:
  - name: auth
    invoke: !ref Authorize
    inputs:
      redirectUri: !cel "resources.Loopback.status.redirectUri"
  - invoke: !ref Console.writeLine
    inputs:
      output: !cel "'Open this URL to authorize:\n' + steps.auth.result.url"
  - name: redirect
    invoke: !ref AwaitRedirect
    inputs:
      state: !cel "steps.auth.result.state"
  - name: tokens
    invoke: !ref Exchange
    inputs:
      code: !cel "steps.redirect.result.code"
      codeVerifier: !cel "steps.auth.result.codeVerifier"
      redirectUri: !cel "steps.auth.result.redirectUri"
      iss: !cel "steps.redirect.result.iss"      # verified against the declared issuer
  - invoke: !ref SaveGrant
    inputs:
      tokens: !cel "steps.tokens.result"
```

Afterwards, calls are ordinary requests:

```yaml
kind: OAuth.Credential
metadata: { name: GoogleAuth }
source: !ref Tokens
---
kind: Http.Client
metadata: { name: Sheets }
baseUrl: https://sheets.googleapis.com/v4
credential: !ref GoogleAuth
---
kind: Http.Request
metadata: { name: ReadSheet }
client: !ref Sheets
```

## Documentation

- [Flows](docs/flows.md) — the four ways in, and which to choose.
- [Grants and storage](docs/grants.md) — keys, refresh, rotation, multi-user.
- [Security](docs/security.md) — what is verified, what is stored, what is not.
