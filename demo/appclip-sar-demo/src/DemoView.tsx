import { useEffect, useId, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { DemoModel } from './useDemo';
import type { SarPlatform } from './sar';

const RAIL_ORDER: SarPlatform[] = ['cashapp', 'paypal', 'upi'];
const RAIL_LOGOS: Record<SarPlatform, string> = {
  cashapp: '/cashapp.svg',
  paypal: '/paypal.svg',
  upi: '/amazon-pay.png',
};
const RAIL_PLACEHOLDERS: Record<SarPlatform, string> = {
  cashapp: '$username',
  paypal: 'username',
  upi: 'name@bank',
};
const LINK_TTL_MS = 15 * 60_000;

type Tone = 'idle' | 'active' | 'connected' | 'paused';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
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

function expiryPercent(expiresAt: number, now: number): number {
  const fraction = (expiresAt - now) / LINK_TTL_MS;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

export function DemoView({ model }: { model: DemoModel }) {
  const { rails, rail, payee, paypalEmail, sar } = model;
  const payeeId = useId();
  const payeeHintId = useId();
  const paypalEmailId = useId();
  const paypalEmailHintId = useId();
  const now = useNow(Boolean(sar.link));
  const link = sar.link;
  const expired = link ? link.expiresAt <= now : false;
  const status = sar.result?.status;
  const connected = status === 'connected';
  const cancelled = status === 'cancelled';
  const linkActive = Boolean(link) && !expired && !cancelled && !connected;
  const formLocked = Boolean(link) && !expired && !cancelled;
  const railTitle = rails[rail].title;
  const payeeDisplay = payee.trim();

  const tone: Tone = connected
    ? 'connected'
    : expired || Boolean(sar.error) || Boolean(sar.accountStatusError)
      ? 'paused'
      : linkActive
        ? 'active'
        : sar.available
          ? 'connected'
          : 'idle';

  const statusLabel = connected
    ? 'Connected'
    : expired
      ? 'Link expired'
      : cancelled
        ? 'Cancelled'
        : status === 'connecting'
          ? 'Connecting…'
          : linkActive
            ? 'Waiting for your iPhone'
            : sar.available
              ? 'Already connected'
              : 'Not connected';

  return (
    <main className="shell">
      <header className="masthead">
        <img className="logo" src="/peer-logo-colour.svg" alt="Peer" width={92} height={32} />
        <span className="masthead-tag">iPhone App Clip</span>
      </header>

      <section className="card" aria-labelledby="form-title">
        <div className="card-head">
          <h1 id="form-title" className="title">Connect a payout account</h1>
          <p className="subtitle">
            Link your {railTitle} account so Peer can confirm payments to it. Peer only reads your
            receipts; connecting never moves money and needs no wallet.
          </p>
        </div>

        <fieldset className="field" data-testid="rail" disabled={formLocked}>
          <legend className="label">
            <span className="step" aria-hidden="true">1</span>
            Choose an account
          </legend>
          <div className="segmented" role="radiogroup" aria-label="Payout platform">
            {RAIL_ORDER.map((key) => (
              <label key={key} className={`segment${rail === key ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="rail"
                  value={key}
                  checked={rail === key}
                  onChange={() => model.setRail(key)}
                  disabled={formLocked}
                />
                <span className="segment-logo">
                  <img className="rail-logo" src={RAIL_LOGOS[key]} alt="" width={24} height={24} />
                </span>
                <span className="segment-title">{rails[key].title}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor={payeeId} className="label">
            <span className="step" aria-hidden="true">2</span>
            {rails[rail].label}
          </label>
          <input
            id={payeeId}
            data-testid="payee"
            className="input"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
            placeholder={RAIL_PLACEHOLDERS[rail]}
            value={payee}
            onChange={(event) => model.setPayee(event.target.value)}
            disabled={formLocked}
            aria-describedby={payeeHintId}
          />
          <p id={payeeHintId} className="hint">
            {formLocked
              ? 'Locked while a link is active. Cancel the link to change it.'
              : `The ${railTitle} account you will sign in to on your iPhone.`}
          </p>
        </div>

        {rail === 'paypal' ? (
          <div className="field">
            <label htmlFor={paypalEmailId} className="label">
              <span className="step step-sub" aria-hidden="true" />
              PayPal account email
            </label>
            <input
              id={paypalEmailId}
              data-testid="paypal-email"
              className="input"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              placeholder="name@example.com"
              value={paypalEmail}
              onChange={(event) => model.setPaypalEmail(event.target.value)}
              disabled={formLocked}
              aria-describedby={paypalEmailHintId}
            />
            <p id={paypalEmailHintId} className="hint">Used to match receipts from your PayPal account.</p>
          </div>
        ) : null}

        <section className="connect" aria-labelledby="connect-title">
          <div className="connect-head">
            <h2 id="connect-title" className="label">
              <span className="step" aria-hidden="true">3</span>
              Confirm on iPhone
            </h2>
            <span
              className={`status is-${tone}`}
              data-testid="sar-status"
              role="status"
              aria-live="polite"
            >
              <span className="status-dot" aria-hidden="true" />
              {statusLabel}
            </span>
          </div>

          {connected ? (
            <div className="panel panel-connected">
              <div className="connected-row">
                <span className="connected-mark" aria-hidden="true">
                  <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
                    <path
                      d="M4 10.5l4 4 8-9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <div className="connected-copy">
                  <p className="connected-title">{railTitle} connected</p>
                  <p className="hint">
                    Peer can now confirm payments to{' '}
                    {payeeDisplay ? <span className="handle">{payeeDisplay}</span> : 'this account'}.
                  </p>
                </div>
              </div>
              <button type="button" className="btn btn-secondary btn-block" onClick={sar.reset}>
                Connect another account
              </button>
            </div>
          ) : !linkActive ? (
            <div className="panel">
              {expired ? (
                <p className="note">The previous link expired. Create a new one to continue.</p>
              ) : cancelled ? (
                <p className="note">That link was cancelled. Create a new one when you are ready.</p>
              ) : sar.available ? (
                <p className="note note-ok">
                  This {railTitle} account is already connected to Peer. You can connect it again at any time.
                </p>
              ) : null}

              <button
                type="button"
                className="btn btn-primary"
                data-testid="sar-create"
                onClick={() => void sar.start()}
                disabled={sar.busy}
                aria-busy={sar.busy || undefined}
              >
                {sar.busy ? 'Creating link…' : link ? 'Create a new link' : 'Connect on iPhone'}
              </button>

              {sar.error ? <p className="alert" role="alert">{sar.error}</p> : null}
              {sar.accountStatusError ? <p className="alert" role="alert">{sar.accountStatusError}</p> : null}

              <ol className="how">
                <li>Scan the code, or open the link on this iPhone.</li>
                <li>Sign in to {railTitle} inside the Peer App Clip.</li>
                <li>Come back here. The status updates on its own.</li>
              </ol>
            </div>
          ) : link ? (
            <div className="panel panel-link">
              <div className="qr">
                <QRCodeSVG
                  value={link.url}
                  size={168}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                  marginSize={2}
                  title="Scan with your iPhone camera to open the Peer App Clip"
                />
              </div>
              <div className="link-body">
                <p className="link-copy">
                  Scan with your iPhone camera, or open the link on this iPhone. Sign in to {railTitle} in
                  the App Clip and this page will update.
                </p>
                <div className="expiry">
                  <div
                    className="expiry-bar"
                    role="progressbar"
                    aria-label="Time remaining on this link"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={expiryPercent(link.expiresAt, now)}
                  >
                    <span className="expiry-fill" style={{ width: `${expiryPercent(link.expiresAt, now)}%` }} />
                  </div>
                  <p className="expiry-label">{expiryLabel(link.expiresAt, now)} · links last 15 minutes</p>
                </div>
              </div>
              {sar.error ? <p className="alert panel-span" role="alert">{sar.error}</p> : null}
              <div className="actions panel-span">
                <a
                  className="btn btn-primary"
                  data-testid="sar-open"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on iPhone
                </a>
                <div className="actions-row">
                  <button type="button" className="btn btn-quiet" onClick={sar.refresh} disabled={sar.busy}>
                    Check status
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    data-testid="sar-cancel"
                    onClick={() => void sar.cancel()}
                    disabled={sar.busy}
                  >
                    Cancel link
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </section>

      <p className="foot">
        Peer gets read-only access to confirm payments. Connecting cannot move funds from your account.
      </p>
    </main>
  );
}
