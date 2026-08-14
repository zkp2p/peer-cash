# Peer Cash Revenue Hook for Uniswap v4

`PeerCashRevenueHook` turns protocol or creator swap revenue into an explicit,
non-custodial Peer Cash lifecycle. It accrues a bounded fee as Base USDC
PoolManager claims, lets anyone flush those claims to one immutable beneficiary,
and leaves the beneficiary to cash out with the ordinary `@zkp2p/cash` SDK.

This is deliberately two systems joined at a safe boundary:

```text
Uniswap v4 swap
  -> afterSwap accounts a Base USDC fee as PoolManager claims
  -> permissionless flush sends all claims to the immutable beneficiary
  -> beneficiary signs an ordinary Peer Cash cashout
  -> buyer pays fiat at the live oracle rate and proves payment
```

Peer Cash, Relay, the curator, ERC-20 transfers, and arbitrary external calls are
never invoked inside the swap callback. A Peer outage cannot revert a swap, and
a caller of `flushRevenue()` cannot redirect the funds.

## Why the boundary is asynchronous

Uniswap v4 requires every callback delta to settle before the PoolManager
unlock completes. Its [flash-accounting model](https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting)
supports taking the fee as an ERC-6909 claim without transferring USDC during
the callback. The [security framework](https://developers.uniswap.org/docs/protocols/v4/security)
also treats external callback calls as a reentrancy and availability boundary.

A Peer Cash order is intentionally longer-lived: the beneficiary approves and
deposits USDC, a buyer later pays fiat, and TEE-TLS proves that payment before
the protocol releases funds. Making that lifecycle atomic with a swap would
either be impossible or let curator, Relay, wallet, or payout-rail availability
break Uniswap execution. The claim-to-beneficiary handoff preserves v4 delta
solvency while keeping the offramp explicit and recoverable.

## Fee semantics

The fee applies only when canonical Base USDC is the swap's _unspecified_
currency:

- exact-input swaps are charged when Base USDC is output;
- exact-output swaps are charged when Base USDC is input;
- swaps whose unspecified currency is not Base USDC are unchanged.

This preserves the user's specified amount. Fees are set once at deployment,
must be between 1 and 100 basis points, and cannot be upgraded or changed. The
hook ignores `hookData`; all callers get identical economics.

The hook address enables only `afterSwap` and `afterSwapReturnDelta`. One hook
can serve multiple pools, but every pool using it must pair against its immutable
Base USDC cash asset for fees to accrue.

## Test locally

From the repository root:

```sh
bun install
bun run hook:build
bun run hook:test
```

The Forge suite uses a fresh v4 PoolManager and covers both swap directions,
exact-input and exact-output accounting, non-USDC bypass, ERC-6909 claim
conservation, flush authorization, and fuzzed fee bounds.

## Deploy on Base

The script pins the [official Base v4 PoolManager](https://developers.uniswap.org/docs/protocols/v4/deployments)
and canonical Base USDC. It mines the permission bits into the CREATE2 address
using Uniswap's `HookMiner`.

```sh
export BENEFICIARY=0xYourRevenueWallet
export FEE_BPS=50

node_modules/.bin/forge script \
  --root examples/uniswap-v4-hook \
  script/DeployPeerCashRevenueHook.s.sol:DeployPeerCashRevenueHook \
  --rpc-url "$BASE_RPC_URL" \
  --account your-foundry-keystore-account \
  --broadcast \
  --verify
```

Do not pass raw keys on the command line. Verify the deployed source and the
immutable `poolManager`, `cashAsset`, `beneficiary`, and `feeBps` values before
creating a pool.

## Operate the cash-out boundary

The included operator example verifies the connected wallet is the beneficiary
and the hook asset is canonical Base USDC. It waits for the flush receipt, reads
the exact amount from `RevenueFlushed`, then creates one Base-only Peer Cash
order. If cash-out fails after the flush, the USDC remains in the beneficiary
wallet; follow the returned `CashError` and do not flush the same revenue twice.

```sh
PRIVATE_KEY=0x... \
HOOK_ADDRESS=0x... \
CASH_PLATFORM=revolut \
CASH_CURRENCY=USD \
CASH_PAYEE=your-revtag \
MIN_CASHOUT_USDC=1 \
bun examples/uniswap-v4-hook/operator.ts
```

The estimate and eventual fill rate are never locked by the hook. Peer Cash uses
the live Chainlink oracle rate when a buyer fills the order.

## Security and registry readiness

This repository provides reference code and tests, not an audit. Do not deploy
it to mainnet or seed real liquidity until an independent v4-hook audit has
reviewed delta accounting, claim solvency, PoolManager unlock behavior, token
assumptions, and multi-pool/multi-hop interactions.

After audit and deployment:

1. verify the exact source and constructor arguments on Base;
2. publish the audit, test evidence, hook address, and example pool;
3. request [Uniswap routing support](https://developers.uniswap.org/hook-allowlist)
   because return-delta hooks require review;
4. submit that same canonical evidence to reputable hook registries.

Uniswap's [hook security framework](https://developers.uniswap.org/docs/protocols/v4/security)
and [hook discovery page](https://developers.uniswap.org/docs/community/learning/hook-discovery)
are the primary references for review and distribution.
