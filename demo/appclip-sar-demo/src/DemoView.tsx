import { useEffect, useId, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { DemoModel, DemoRail } from './useDemo';

const RAIL_ORDER: DemoRail[] = ['cashapp', 'paypal', 'upi'];
const RAIL_LOGOS: Record<DemoRail, string> = {
  cashapp: '/cashapp.svg',
  paypal: '/paypal.svg',
  upi: '/amazon-pay.png',
};

function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function formatMoney(value: number, currency: 'USD' | 'INR'): string {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRate(rate: number, currency: 'USD' | 'INR'): string {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 4,
  }).format(rate);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** Ticks once per 15s so the SAR link expiry label stays honest without re-rendering the form constantly. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function expiryLabel(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Link expired';
  const minutes = Math.ceil(remaining / 60_000);
  return minutes <= 1 ? 'Expires in under a minute' : `Expires in ${minutes} min`;
}

export function DemoView({ model }: { model: DemoModel }) {
  const { auth, rails, rail, railSupported, amount, payee, estimate, sar, cashout, order } = model;
  const railMeta = rails[rail];
  const amountId = useId();
  const payeeId = useId();
  const amountHintId = `${amountId}-hint`;
  const payeeHintId = `${payeeId}-hint`;
  const sarActive = Boolean(sar.link) && !order.data;
  const now = useNow(sarActive);

  const signedIn = auth.ready && auth.authenticated;
  const walletReady = signedIn && Boolean(auth.address);
  const formEnabled = walletReady && !order.data;

  return (
    <main className="shell">
      <header className="masthead">
        <img className="logo" src="/peer-logo-colour.svg" alt="Peer" width={92} height={32} />
        <div className="auth" data-testid="auth">
          {!auth.ready ? (
            <span className="muted" role="status" aria-live="polite">Checking sign-in…</span>
          ) : auth.authenticated ? (
            <>
              <span className="auth-identity" title={auth.address ?? undefined}>
                {auth.email ?? (auth.address ? shortAddress(auth.address) : 'Signed in')}
              </span>
              <button type="button" className="btn btn-quiet" onClick={() => void auth.logout()}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => auth.login()}>
              Sign in
            </button>
          )}
        </div>
      </header>

      <section className="form" aria-labelledby="form-title">
        <h1 id="form-title" className="title">Cash out USDC</h1>
        <p className="subtitle">Base USDC to your account at the live oracle rate. 0% spread.</p>

        {signedIn && !auth.address ? (
          <p className="notice" role="status" aria-live="polite">
            Setting up your wallet. This usually takes a moment.
          </p>
        ) : null}

        {order.data ? (
          <OrderPanel model={model} />
        ) : (
          <>
            {/* Amount */}
            <div className="field field-amount">
              <label htmlFor={amountId} className="label">You send</label>
              <div className="amount-control">
                <input
                  id={amountId}
                  data-testid="amount"
                  className="amount-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => model.setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                  aria-describedby={amountHintId}
                  disabled={!formEnabled}
                />
                <span className="amount-unit" aria-hidden="true">USDC</span>
              </div>
              <p id={amountHintId} className="hint">USDC on Base. Minimum 0.01.</p>
            </div>

            {/* Rail */}
            <fieldset className="field" data-testid="rail">
              <legend className="label">Receive on</legend>
              <div className="segmented" role="radiogroup" aria-label="Payout platform">
                {RAIL_ORDER.map((key) => (
                  <label key={key} className={`segment${rail === key ? ' is-selected' : ''}`}>
                    <input
                      type="radio"
                      name="rail"
                      value={key}
                      checked={rail === key}
                      onChange={() => model.setRail(key)}
                      disabled={!formEnabled}
                    />
                    <img className="rail-logo" src={RAIL_LOGOS[key]} alt="" width={22} height={22} />
                    <span>{rails[key].title}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Receive amount */}
            <div className="row row-receive" aria-live="polite">
              <span className="row-key">You receive</span>
              <span className="row-value">
                {!railSupported ? (
                  <span className="muted">{railMeta.title} is not available right now</span>
                ) : model.estimateBusy ? (
                  <span className="muted">Estimating…</span>
                ) : model.estimateError ? (
                  <span className="text-error">{model.estimateError}</span>
                ) : estimate ? (
                  <>≈ {formatMoney(estimate.receiveAmount, railMeta.currency)}</>
                ) : (
                  <span className="muted">≈ {formatMoney(0, railMeta.currency)}</span>
                )}
              </span>
            </div>

            {/* Payee */}
            <div className="field">
              <label htmlFor={payeeId} className="label">{railMeta.label}</label>
              <input
                id={payeeId}
                data-testid="payee"
                className="input"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={model.payeeHint || railMeta.label}
                value={payee}
                onChange={(event) => model.setPayee(event.target.value)}
                aria-describedby={payeeHintId}
                disabled={!formEnabled}
              />
              <p id={payeeHintId} className="hint">
                {model.requiresIdentityAttestation
                  ? `A ${railMeta.title} handle you have not used with Peer before needs identity verification first. A handle you already registered works as is.`
                  : `Payments arrive at this ${railMeta.label}. Check it before you continue.`}
              </p>
            </div>

            {/* App Clip SAR (optional) */}
            {walletReady ? <SarRow model={model} now={now} /> : null}

            {/* Rate / binding */}
            <div className="meta">
              <div className="row">
                <span className="row-key">Rate</span>
                <span className="row-value">
                  {estimate
                    ? `1 USDC = ${formatRate(estimate.rate, railMeta.currency)}${estimate.stale ? ' · stale feed' : ''}`
                    : '—'}
                </span>
              </div>
              <p className="hint">
                Estimate only. The binding rate is read from the Chainlink oracle when a buyer fills your cash-out.
                {estimate?.amount ? ` Deposit: ${formatUsdc(estimate.amount)} USDC.` : ''}
              </p>
            </div>

            {cashout.error ? (
              <p className="alert" role="alert">{cashout.error}</p>
            ) : null}

            <button
              type="button"
              className="btn btn-primary"
              data-testid="cashout-submit"
              onClick={() => signedIn ? void cashout.start() : auth.login()}
              disabled={!auth.ready || (signedIn && (!formEnabled || cashout.busy || !railSupported))}
              aria-busy={cashout.busy || undefined}
            >
              {!auth.ready
                ? 'Checking sign-in…'
                : !signedIn
                  ? 'Sign in to cash out'
                  : cashout.busy
                    ? 'Confirm in your wallet…'
                    : `Cash out to ${railMeta.title}`}
            </button>
            {!signedIn && auth.ready ? (
              <p className="hint hint-center">Sign in above to create a cash-out.</p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function SarRow({ model, now }: { model: DemoModel; now: number }) {
  const { sar, rail, rails } = model;
  const link = sar.link;
  const status = sar.result?.status ?? null;
  const expired = link ? link.expiresAt <= now : false;
  const connected = link ? status === 'connected' : Boolean(sar.account);

  let statusLabel: string;
  if (connected) statusLabel = 'Connected';
  else if (!link) statusLabel = 'Not connected';
  else if (expired) statusLabel = 'Link expired';
  else if (sar.error) statusLabel = 'Paused';
  else if (status === 'connecting') statusLabel = 'Connecting…';
  else statusLabel = 'Waiting for your iPhone';

  return (
    <div className="sar">
      <div className="sar-head">
        <div>
          <span className="label">{rails[rail].title} account on iPhone</span>
          <span className="tag">Optional</span>
        </div>
        <span
          className={`sar-status${connected ? ' is-connected' : sar.error || expired ? ' is-paused' : ''}`}
          data-testid="sar-status"
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>
      <p className="hint">
        Connecting lets Peer confirm incoming payments to this account. It cannot move funds, and it is not
        required to cash out{rail === 'upi' ? ' with UPI' : ''}.
      </p>

      {!link && connected ? (
        <p className="sar-connected">
          Peer can confirm payments to {sar.account?.offchainId} through your {rails[rail].title} account.
        </p>
      ) : !link ? (
        <div className="sar-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="sar-create"
            onClick={() => void sar.start()}
            disabled={sar.busy}
            aria-busy={sar.busy || undefined}
          >
            {sar.busy ? 'Creating link…' : 'Connect on iPhone'}
          </button>
          {sar.error ? <p className="alert" role="alert">{sar.error}</p> : null}
          {sar.accountsError ? <p className="alert" role="alert">{sar.accountsError}</p> : null}
        </div>
      ) : connected ? (
        <p className="sar-connected">Peer can now confirm payments to your {rails[rail].title} account.</p>
      ) : (
        <div className="sar-link">
          <div className="qr" aria-hidden={expired || undefined}>
            <QRCodeSVG
              value={link.url}
              size={132}
              bgColor="#ffffff"
              fgColor="#000000"
              level="M"
              marginSize={2}
              title="Scan with your iPhone camera to open the Peer App Clip"
            />
          </div>
          <div className="sar-link-body">
            <p className="sar-link-copy">
              Scan with your iPhone camera, or open the link on this iPhone. The App Clip only reads your account
              details to confirm payments.
            </p>
            <p className="sar-expiry">{expiryLabel(link.expiresAt, now)} · links last 15 minutes</p>
            {sar.error ? <p className="alert" role="alert">{sar.error}</p> : null}
            <div className="sar-actions">
              {!expired ? (
                <a
                  className="btn btn-secondary"
                  data-testid="sar-open"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on iPhone
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="sar-create"
                  onClick={() => void sar.start()}
                  disabled={sar.busy}
                >
                  {sar.busy ? 'Creating link…' : 'Create a new link'}
                </button>
              )}
              {!expired ? (
                <button type="button" className="btn btn-quiet" onClick={() => sar.refresh()} disabled={sar.busy}>
                  Check status
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-quiet"
                data-testid="sar-cancel"
                onClick={() => void sar.cancel()}
                disabled={sar.busy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderPanel({ model }: { model: DemoModel }) {
  const { order, cashout } = model;
  const data = order.data;
  if (!data) return null;
  const settled = data.state === 'delivered' || data.state === 'returned';

  return (
    <div className="order">
      <div className="row">
        <span className="row-key">Status</span>
        <span className="row-value order-state" data-testid="order-state" role="status" aria-live="polite">
          {data.state}
        </span>
      </div>
      <p className="order-explanation" aria-live="polite">{data.explanation}</p>

      <div className="row row-stack">
        <span className="row-key">Deposit ID</span>
        <code className="mono">{data.depositId}</code>
      </div>
      {data.txHash ? (
        <div className="row">
          <span className="row-key">Transaction</span>
          <a
            className="mono link"
            href={`https://basescan.org/tx/${data.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortHash(data.txHash)}
          </a>
        </div>
      ) : (
        <p className="hint">No transaction hash was recorded. Check this deposit before creating another.</p>
      )}

      {order.error ? <p className="alert" role="alert">{order.error}</p> : null}

      <div className="order-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => order.refresh()}
          disabled={cashout.busy}
        >
          Refresh
        </button>
        {data.canWithdraw ? (
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="order-withdraw"
            onClick={() => void order.withdraw()}
            disabled={cashout.busy}
            aria-busy={cashout.busy || undefined}
          >
            {cashout.busy ? 'Confirm in your wallet…' : 'Withdraw USDC'}
          </button>
        ) : null}
      </div>
      <p className="hint">
        Withdraw returns unfilled USDC to your wallet. Keep this deposit ID: it is all you need to find this
        cash-out again.
      </p>
      <button type="button" className="btn btn-quiet btn-block" onClick={() => order.newCashout()}>
        {settled ? 'Start another cash-out' : 'Hide and start another cash-out'}
      </button>
    </div>
  );
}
