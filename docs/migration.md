# Migrating from 0.7.x

Cash-outs no longer configure any whitelist or group, including Venmo and
PayPal deposits. The Peer Pay merchant group is retired on both OrchestratorV3
and OrchestratorV4. Do not attach it, recreate it, manage its membership, or use
membership as a staking exemption. No replacement group is introduced.

## Breaking API removals

Remove these methods and fields from integrations:

- `CashClient.prepareAccessPolicy()`.
- `PrepareResult.accessPolicyRequired` and `accessPolicyPaymentMethods`.
- `CashoutResult.accessPolicyTxHash` and `accessPolicyTxHashes`.
- `CashPlatformCapability.requiresAtomicAccessPolicy`.
- `errors.atomicAccessPolicyRequired()` and `errors.accessPolicyConfigurationFailed()`.
- `ATOMIC_ACCESS_POLICY_REQUIRED` and `ACCESS_POLICY_CONFIGURATION_FAILED`
  error codes, and the `configure-cashout-access-policy` recovery kind.

The corresponding JSON schemas and codecs no longer expose these fields or
accept the retired error codes and recovery kind. Remove policy follow-up
loops, capability gates, policy hash persistence, and policy retry handlers.

## Updated execution flow

Signed `cashout()` returns after confirming the deposit. Persist its
`depositId` and `txHash`; Relay-funded results still include `source` evidence.
Venmo and PayPal retain the protocol's default dispute protection without a
group-based staking exemption.

For external signing, submit `prepare().txs` in order and confirm each receipt.
Call `finalizePreparedCashout(createDepositReceipt)` and persist `depositId`.
The cash-out is then ready to observe with `order()` or `watch()`.

Existing deposits and group allowances are unchanged by this SDK update. If an
older cash-out failed during its policy follow-up, the deposit already exists:
resume from its stored `depositId` and inspect any outstanding transaction.
Do not repeat the cash-out or submit a replacement policy transaction. Keep
old error records as historical evidence rather than passing them through the
new error codec. Existing deposits can still be observed and withdrawn through
the normal lifecycle APIs.

## Release requirement

This change requires a minor release under this repository's pre-1.0 semver
convention: `0.8.0` after `0.7.3` (or a `0.8.0-rc.N` candidate). The version
bump belongs in the separate version-only release PR described in `CLAUDE.md`.
The dependency remains pinned to `@zkp2p/sdk` `0.15.0-rc.2`, whose
`createDeposit()` enables trusted-group bypass only on an explicit `true`.
