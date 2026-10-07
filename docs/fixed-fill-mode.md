# Automatic fixed fills

**Unreleased breaking change from 0.7.2.** This feature must ship in a new
pre-1.0 minor release. The published 0.7.2 package does not expose `fillMode`.

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

With the default 50-USDC increment, every other total rejects, including 550, 650, 850, 950, 1,200, 1,250,
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

## Breaking change from 0.7.2

Previously, omitting `intentAmountRange` accepted arbitrary totals from 0.01
USDC and set `min = min(1 USDC, amount)`, `max = amount`. After upgrading,
omitting both `fillMode` and `intentAmountRange` on a USD-only Venmo, PayPal
or Cash App payout set selects the fixed table above. The change also applies
to `prepare()` and to `estimate()` when a qualifying platform is supplied.

| Input with no fill options | 0.7.2       | New default on the three USD rails |
| -------------------------- | ----------- | ---------------------------------- |
| 900 USDC                   | Range 1–900 | Exactly 300 per payment            |
| 950 USDC                   | Range 1–950 | `FIXED_AMOUNT_NOT_PRESET`          |
| 5 USDC                     | Range 1–5   | `FIXED_AMOUNT_NOT_PRESET`          |

To keep accepting arbitrary totals, set flexible mode on **both** previews
and submission after upgrading:

```ts
const amount = usdc(950);
const fillMode = 'flexible' as const;
await cash.estimate({ amount, currency: 'USD', platform: 'venmo', fillMode });
await cash.cashout(
  { amount, receive: { platform: 'venmo', currency: 'USD', payee: '@recipient' }, fillMode },
  { signer },
);
// For external signing, pass the same fillMode to cash.prepare().
```

For fixed defaults, offer only approved totals and display the resolved equal
bounds before signing. `capabilities().amount` remains the general product
floor, not the fixed-mode allowlist. A currency-only estimate cannot validate
a platform's default. For mixed payout sets, preview with an explicit mode
matching the whole set; a single-platform estimate does not describe every leg.

TypeScript integrators extending `CashoutInput`, `EstimateInput`, or
`UseEstimateOptions` with an `interface` must use a type intersection instead:
these types now include a discriminated union to prevent fixed mode plus raw
bounds. For example, use `type AppCashout = CashoutInput & { requestId: string }`.
Exhaustive error handling must include `INVALID_FILL_CONFIGURATION`,
`FIXED_CURRENCY_UNSUPPORTED`, `FIXED_AMOUNT_NOT_PRESET`, and the
`INVALID_MIN_CHUNK_SIZE` / `FIXED_AMOUNT_UNSPLITTABLE` codes for custom
increments, plus the `select-fixed-amount` recovery variant. Narrow `recovery.kind` before reading
source-route fields; the new variant carries only `allowedAmounts`.

Existing deposits keep their on-chain bounds; an upgrade does not resize
them. Existing explicit ranges, other payout sets and source recovery retain
their behavior. Serialized results from older SDKs may omit the added bounds.

## Explicit choices

- `fillMode: 'fixed'` selects these automatic presets on any supported USD
  payout set. Non-USD currencies reject, including USD plus another currency.
- `fillMode: 'flexible'` retains the previous range: minimum 1 USDC (or the
  whole total when smaller), maximum the full total. The existing $0.01
  cash-out floor still applies to flexible mode.
- Existing `intentAmountRange: { min, max }` inputs remain explicit flexible
  overrides when mode is omitted. Fixed mode plus a raw range rejects.
- Other platforms, non-USD PayPal, and mixed payout sets containing another
  platform default to flexible. An order has one shared range across all legs.

`FIXED_AMOUNT_NOT_PRESET` returns `recovery.allowedAmounts`, the complete
allowlist as base-unit strings. `INVALID_FILL_CONFIGURATION` rejects unknown
modes, conflicting bounds and attempted `intentAmount` overrides.
`FIXED_CURRENCY_UNSUPPORTED` identifies non-USD fixed requests.

## Custom minimum chunk and increment

In explicit fixed mode, `minChunkSize` sets both the minimum chunk and the
increment. It uses USDC base units: `usdc(25)` permits 25, 50, 75, 100 and
other multiples of 25 through 500. It does not pin the actual ticket.

```ts
const fill = { fillMode: 'fixed' as const, minChunkSize: usdc(25) };
const amount = usdc(950);
const estimate = await cash.estimate(
  { amount, currency: 'USD', platform: 'venmo', ...fill },
  { includeEta: false },
);
// Two payments: { min: 475_000_000n, max: 475_000_000n }
await cash.cashout(
  { amount, receive: { platform: 'venmo', currency: 'USD', payee: '@recipient' }, ...fill },
  { signer },
);
```

Omitting `minChunkSize`, or explicitly passing `usdc(50)`, always uses the
original preset table, including 900 → 3 × 300 and rejection of 650/950.
Other increments use this deterministic rule:

1. Accept a whole-USDC increment from 1 through 500; reject anything else.
2. Require the total to be at least the increment and at most 10,000 USDC.
3. Try payment counts from 1 through 3 for totals below 1,000, or 1 through
   20 otherwise. Choose the first count that divides the total exactly and
   produces a chunk no greater than 500 and divisible by the increment.
4. Set both bounds to that chunk. Reject if no count qualifies.

This chooses the fewest equal payments, or equivalently the largest eligible
chunk. With increment 25, 650 → 2 × 325, 900 → 2 × 450 and 950 → 2 × 475.
575 rejects: its only eligible split needs 23 payments. No rounding, remainder
payment or relaxation occurs. The smaller increment does not raise the caps.

`minChunkSize` requires explicit `fillMode: 'fixed'`; supplying it with an
omitted or flexible mode raises `INVALID_FILL_CONFIGURATION`. Invalid
increments raise `INVALID_MIN_CHUNK_SIZE`; totals with no eligible split raise
`FIXED_AMOUNT_UNSPLITTABLE`. Only the default preset error returns an
`allowedAmounts` list. Use the same increment in `useEstimate()` / `estimate()`,
`prepare()` and `cashout()`; JSON codecs and tools encode it as a decimal string.

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
