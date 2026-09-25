# Peer App Clip account connection demo

This standalone example connects a Cash App, PayPal, or Amazon Pay UPI account
through the Peer App Clip. It does not create a cash-out, require a wallet, or use
Privy. Curator generates a short-lived connection capability and an internal
session address to bind the provider proof. The address is never requested from
or displayed to the visitor.

## Run

1. `bun install --frozen-lockfile`
2. Copy `.env.example` to `.env.local` and select the Curator environment.
3. `bun run dev`

For preprod QA, set `VITE_CURATOR_API_URL=https://api-preprod.zkp2p.xyz`.
When running on localhost, set `VITE_SAR_RETURN_URL` to an HTTPS return origin
allowed by that Curator environment. The Clip returns to that site; keep the
local demo open to observe its connection status. Preprod links use a `t`
request prefix and open the preprod App Clip.

Choose a payout platform, enter its account identifier and choose **Connect on
iPhone**. Curator creates a rate-limited, 15-minute demo capability. Scan the QR
code or open the link on an iPhone, confirm the selected account in the App Clip,
and sign in to the provider there. The page polls Curator for the result. A
provider credential is stored only after the App Clip verifies the provider
account; the visitor never enters a Peer wallet or Privy account. The demo can
start another connection after completion.

Use `bun run typecheck`, `bun run test`, and `bun run build` to verify the
example. The production origin is `https://peer-cash-appclip-demo.vercel.app`;
Curator's return-origin and CORS allowlists must include it. Vercel builds from
this directory.
