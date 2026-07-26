# Optional AI Pass account connection

AI Pass is integrated as an OAuth account connection, not as an API-key
provider preset. It is optional and unavailable until its protected runtime
configuration and callback registration are present.

## Evaluation and maintainer replacement

If a verified evaluation build is linked from a draft, download and run that
build, then click **Connect AI Pass**. A private fork build may receive an AI
Pass existing first-party PUBLIC client ID from a repository secret or
protected CI/build configuration only when its exact callback is registered.
This is evaluation-only, not an API key or client secret, and not upstream
release guidance. The value must never be committed, printed, logged, returned
by an application API, or included in upstream source.

To replace it with your own client:

1. Register Vibe Tavern in the
   [AI Pass Developer Dashboard](https://aipass.one/panel/developer).
2. Register
   `https://<your-Vibe-Tavern-origin>/oauth/aipass/callback` exactly,
   substituting the HTTPS origin that serves the app.
3. Replace any evaluation ID by setting `VIBE_TAVERN_AIPASS_CLIENT_ID` to your
   public client ID and `VIBE_TAVERN_AIPASS_REDIRECT_URI` to that exact callback
   in protected backend configuration (never in a `VITE_*` variable or
   frontend bundle):

- `VIBE_TAVERN_AIPASS_CLIENT_ID`: the maintainer-owned public OAuth client ID.
- `VIBE_TAVERN_AIPASS_REDIRECT_URI`: the registered callback URI. It must use
  HTTPS and its path must be `/oauth/aipass/callback`.

Example runtime configuration (leave example values blank):

```env
VIBE_TAVERN_AIPASS_CLIENT_ID=
VIBE_TAVERN_AIPASS_REDIRECT_URI=
```

The callback origin must be the same origin that serves the web app. Standalone
deployments therefore also need the repository's TLS configuration
(`RP_PLATFORM_TLS_KEY` and `RP_PLATFORM_TLS_CERT`) and an exactly matching
callback registered for the public client.

A public client ID identifies Vibe Tavern; it is not an API key, client secret,
or bearer credential. Upstream source remains blank and configurable. Missing
or invalid configuration fails closed.

The backend requires an available operating-system credential store:

- macOS Keychain on macOS;
- DPAPI-protected, user-scoped storage on Windows;
- Secret Service (`secret-tool`) on Linux.

The connection fails closed when any prerequisite is unavailable. There is no
plaintext file or database fallback.

## Security and data flow

1. The browser requests a short-lived, one-time launch path from the same-origin
   backend. The backend redirects that launch to the authorization endpoint
   discovered from AI Pass metadata.
2. The backend creates a 256-bit state value and a PKCE verifier, using S256.
   A short-lived transaction handle is held in an HttpOnly, Secure,
   SameSite=Lax cookie. Pending transactions are memory-only and become invalid
   after a server restart.
3. The callback validates and consumes both the transaction and state before
   exchanging the authorization code. Token, userinfo, and revocation endpoints
   come from the validated authorization-server metadata. Token exchange and
   refresh use AI Pass's current JSON/camelCase public-client payload;
   revocation uses the endpoint's form-encoded request shape.
4. Access and refresh tokens are written atomically as one credential-store
   value. Refreshes are serialized. OAuth completion and disconnect are also
   serialized, and disconnect invalidates pending authorization attempts plus
   in-flight refreshes before clearing storage.
5. The browser receives only redacted connection status and a success/failure
   popup message. It never receives bearer tokens or the configured client ID
   through an application API.
6. Model discovery is live and authenticated at
   `GET https://aipass.one/oauth2/v1/models`. The parser accepts the
   OpenAI-compatible `{ "object": "list", "data": [...] }` envelope, tolerates
   additive record fields, and preserves each non-empty string `id` exactly.
   Legacy top-level string and `{ id }` arrays remain accepted for migration;
   malformed entries and name-only fallbacks are rejected. No fallback model
   IDs are embedded.
7. Generation is pinned to
   `POST https://aipass.one/oauth2/v1/chat/completions`. The backend injects the
   current access token only at execution time. Request/response sizes and
   durations are bounded, and the existing chat AbortSignal reaches the
   upstream response so Stop cancels wallet-billed work.

The generated provider profile contains only non-secret settings and cached
model metadata. Generic provider create, draft-test, and endpoint paths reject
AI Pass, including attempts to disguise its endpoint as OpenAI-compatible BYOK.

## Users and attribution

Users install Vibe Tavern and click **Connect AI Pass** without providing
or pasting model API keys; requests spend from their own shared AI Pass wallet,
and every existing provider remains available. If the maintainer uses their own
OAuth client, eligible paid usage is attributed to Vibe Tavern's integration
and may earn developer revenue share under the
[AI Pass Terms of Service](https://aipass.one/terms-of-service). Usage covered
by free, trial, promotional, grant, bonus, or other unpaid usage is excluded.
Dashboard terms govern rates, eligibility, and payouts. This is optional
context, not a guarantee or a reason to merge. Thank you for considering the
contribution.

See the [AI Pass REST API guide](https://aipass.one/docs/rest) for the OAuth,
model-discovery, and API contracts.

## Manual verification

- With no protected configuration, Provider Settings explains that AI Pass is
  unavailable and every existing provider remains usable.
- Register the exact HTTPS callback on a maintainer-owned OAuth client, set the
  two backend variables, and confirm no client ID is committed or printed.
- With that registered configuration, **Connect AI Pass** opens the consent flow
  for the maintainer-owned client and returns a single AI Pass profile without
  any API-key field.
- Refresh Models returns the current wallet models; an empty list remains
  empty.
- A streamed chat uses the selected AI Pass model. Stop aborts the upstream
  request.
- Disconnect attempts to revoke both access and refresh tokens, clears the
  native credential even if the network is unavailable, and removes the AI
  Pass profile.
- Restarting during an unfinished authorization attempt makes the callback fail
  safely and requires starting again.
