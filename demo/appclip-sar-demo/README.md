# Peer App Clip account connection demo

This standalone example connects a Cash App, PayPal, or Amazon Pay UPI account
through the Peer App Clip on iPhone or the installed Peer app on Android. It
does not create a cash-out, require a wallet, or use Privy. It calls Curator's
`POST /v2/sar/connections/checkout`, which issues a short-lived connection
capability and binds the provider proof to an internal session address. The
visitor never sees or enters that address. Amazon Pay UPI stays paused in
Curator (`SAR_CONNECT_UPI_ENABLED=false`) and returns "unavailable" until it is
enabled.

## Run

1. `bun install --frozen-lockfile`
2. Copy `.env.example` to `.env.local` and select the Curator environment.
3. `bun run dev`

For preprod QA, set `VITE_CURATOR_API_URL=https://api-preprod.zkp2p.xyz`.
The return URL origin must be on that Curator environment's
`SAR_CONNECT_RETURN_ORIGINS` and CORS lists. Otherwise Curator answers
`return_url_is_not_an_approved_caller` and the page says the site is not
approved. When running on localhost, set `VITE_SAR_RETURN_URL` to an approved
HTTPS origin. The Clip returns to that site, so keep the local demo open to
observe its status. Preprod links use a `t` request prefix and open the preprod
App Clip or the `zkp2p-preprod://` app.

Choose a payout platform, enter its account identifier, and choose **Connect on
your phone**. Curator creates a rate-limited, 15-minute capability. Scan the QR
code with an iPhone or Android camera, or open a link on the phone. **Open on
iPhone** opens Curator's App Clip URL (`/clip/connect`) as returned. **Open on
Android** opens the same request on `/connect`, which launches the installed
Peer app. Confirm the selected account and sign in to the provider there. The
page polls Curator for the result every 3 seconds. A provider credential is
stored only after Peer verifies the provider account. The visitor never enters
a Peer wallet or Privy account. The demo can start another connection after
completion.

Use `bun run typecheck`, `bun run test`, and `bun run build` to verify the
example. The production origin is `https://peer-cash-appclip-demo.vercel.app`.
Curator's return-origin and CORS allowlists must include it in each environment
the demo targets. Vercel builds from this directory. Integrators should use
`cash.prepareSarConnect()` from `@zkp2p/cash` rather than copying this file.
