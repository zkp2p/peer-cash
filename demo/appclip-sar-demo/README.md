# Peer Cash · App Clip SAR demo

This standalone example uses `@zkp2p/cash` for USDC cash-outs, Privy for the
seller wallet, and Curator for optional Cash App, PayPal, or Amazon Pay UPI
account connections. An account connection confirms incoming payments; it does
not authorize a cash-out or transfer funds. The UPI payee can be entered without
connecting an Amazon Pay account.

## Run

1. `bun install --frozen-lockfile`
2. Copy `.env.example` to `.env.local` and set a Privy **web** client ID whose
   allowed origins include the exact demo origin. Use the same Privy app as the
   production Peer App Clip so the wallet address is recognized.
3. `bun run dev`

Use `bun run typecheck`, `bun run test`, and `bun run build` to verify the
example. The deployed production origin is
`https://peer-cash-appclip-demo.vercel.app`; its Privy and Curator origin
allowlists must contain that exact origin. Vercel builds from this directory.

Sign in, select a rail, and choose **Connect on iPhone** to create a short-lived
Curator capability and App Clip link. The page polls the capability for status,
validates the wallet, rail, return URL and state, and resumes after returning
from the Clip. The link expires after 15 minutes. Never put a Privy access token
or payment credential in the deep link. A cash-out requires a separate explicit
wallet transaction on Base.
