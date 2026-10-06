# Automatic fixed fills

Cash-outs default to fixed sizing when **every** offered payout leg is USD
Venmo, PayPal or Cash App. One deposit holds the full total; every buyer intent
must equal the selected chunk (`min = max`). There is no manual ticket-size
option. The policy applies in every SDK environment.

| Accepted total (USDC)                 | Equal chunks (USDC)          |
| ------------------------------------- | ---------------------------- |
| 50 through 500, in steps of 50        | One chunk for the full total |
| 600                                   | 2 × 300                      |
| 700                                   | 2 × 350                      |
| 750                                   | 3 × 250                      |
| 800                                   | 2 × 400                      |
| 900                                   | 3 × 300                      |
| 1,000 through 10,000, in steps of 500 | 2 through 20 × 500           |

Every other fixed total rejects, including 550, 650, 850, 950, 1,200, 1,250,
fractions and values above 10,000. There is no rounding, divisor search,
remainder payment or fallback to smaller chunks. Amounts are gross Base-USDC
principal, not merchant proceeds after fees or a promise about platform limits.

```ts
const input = {
  amount: usdc(900),
  receive: { platform: 'venmo', currency: 'USD' as const, payee: '@recipient' },
};
const estimate = await cash.estimate(
  { amount: input.amount, platform: 'venmo', currency: 'USD' },
  { includeEta: false },
);
// estimate.intentAmountRange: { min: 300_000_000n, max: 300_000_000n }
const result = await cash.cashout(input, { signer });
// result.order.intentAmountRange contains the submitted bounds.
```

Supply `platform` to `estimate()` to preview that platform's default. A
currency-only estimate leaves the range absent unless a fill option is
explicit. `prepare()` uses the same sizing and returns `intentAmountRange`.
`useEstimate` accepts the same fill options and discards previews when they
change. JSON codecs encode bounds as decimal base-unit strings.

## Explicit choices and migration

- `fillMode: 'fixed'` selects these automatic presets on any supported USD
  payout set. Non-USD currencies reject, including USD plus another currency.
- `fillMode: 'flexible'` retains the previous range: minimum 1 USDC (or the
  whole total when smaller), maximum the full total. The existing $0.01
  cash-out floor still applies to flexible mode.
- Existing `intentAmountRange: { min, max }` inputs remain explicit flexible
  overrides when mode is omitted. Fixed mode plus a raw range rejects.
- Other platforms, non-USD PayPal, and mixed payout sets containing another
  platform default to flexible. An order has one shared range across all legs.
- Integrations relying on arbitrary amounts for USD Venmo, PayPal or Cash App
  must pass `fillMode: 'flexible'` to retain that behavior. This default change
  requires a pre-1.0 minor release; it is not a patch-release compatibility claim.

`FIXED_AMOUNT_NOT_PRESET` returns `recovery.allowedAmounts`, the complete
allowlist as base-unit strings. `INVALID_FILL_CONFIGURATION` rejects unknown
modes, conflicting bounds and attempted `intentAmount` overrides.
`FIXED_CURRENCY_UNSUPPORTED` identifies non-USD fixed requests.

## Funding, recovery and completion

Relay inputs remain source-token units. Validate the quote's guaranteed Base
USDC output against the presets **before** registration, approvals or route
execution. A fresh quote may become ineligible after an earlier preview.
Exact-input quotes often produce non-preset outputs; select a compatible route
or explicit flexible mode. Never silently round or reroute completed funds.
For NEAR Intents, reconcile the externally funded Base receipt before cashing
out. `prepare()` remains Base-USDC-only.

Resumed `order()` / `orders()` / `watch()` results use the current indexed
bounds. Old serialized results and receipt-only `finalizePreparedCashout()`
results can lack them; read `order()` after indexing. Equal bounds do not prove
which SDK policy originally created the deposit.

Top-ups, partial withdrawals, manual releases and external range changes can
invalidate the original payment count. These existing operations retain their
behavior; no automatic balance repair or minimum relaxation is added. Track
one-shot fixed orders through creation, fills and optional full cancellation.

The existing ETA measures time to **first** fill. Do not present it as time to
full completion; use `includeEta: false` on a full-completion preview. Neither
`state === 'delivered'` (which tolerates dust) nor `deliveredAt` alone proves
strict full settlement. Require actual `FULFILLED` principal to cover the funded
amount with no residual, pending or returned principal; report assisted manual
completion separately. Twenty planned payments is not a completion-time promise.
