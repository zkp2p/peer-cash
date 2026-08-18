// Peer Cash Demo: example integration of @zkp2p/cash in a single
// self-contained page, stored onchain on Base. Mirrors the Peer web express
// sell flow: amount → platform/currency → payee → estimate → cashout(signer)
// → watch() to delivered, with withdraw() as the one unwind verb.
import {
  createCashClient,
  formatUsdc,
  isCashError,
  isUserRejectedError,
  BASE_USDC_ADDRESS,
  USDC_DECIMALS,
} from '@zkp2p/cash';
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  http,
  parseUnits,
} from 'viem';
import { base } from 'viem/chains';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- constants
const PAGE_ADDRESS = '__PAGE_ADDRESS__';
const EXPLORER = base.blockExplorers.default.url;

// The capitalized platform id is right for most rails; list only irregulars.
const PLATFORM_NAMES = { cashapp: 'Cash App' };
const PAYEE_LABELS = {
  cashapp: 'Cashtag', chime: 'ChimeSign', monzo: 'Monzo.me username',
  revolut: 'Revtag', venmo: 'Venmo username', zelle: 'Zelle email',
};
// Demo-level overrides of the catalog's payee hints.
const PAYEE_HINTS = {
  zelle: 'Email enrolled with Zelle (US only)',
};
const platformName = (p) =>
  PLATFORM_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
const payeeLabel = (p) => PAYEE_LABELS[p] ?? 'payout handle';

// Availability gate recommended by the SDK: real recent demand and an
// acceptable median first-fill time. Fail open to the full catalog.
const isPairLive = (s) =>
  Boolean(s && s.fills >= 10 && s.medianFillSeconds <= 48 * 3600);

const formatOrderStateLabel = (state) =>
  state
    ? state.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase())
    : null;

const formatCompactEta = (seconds) => {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return '< 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.max(1, Math.round(minutes / 60))} hr`;
};

const cashErrorMessage = (error) => {
  if (isCashError(error)) {
    if (isUserRejectedError(error)) return 'Transaction cancelled.';
    return error.remediation || error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Peer Cash could not start this cash-out. Please try again.';
};

const fmt2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt4 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

// ------------------------------------------------------------------- client
const cash = createCashClient({
  environment: 'production',
  referrer: 'peer-cash-onchain',
});
const caps = cash.capabilities();
const publicClient = createPublicClient({ chain: base, transport: http() });

// -------------------------------------------------------------------- state
const state = {
  account: null,
  walletClient: null,
  balance: null,
  amount: '',
  amountWei: null,
  platform: null,
  currency: null,
  payee: '',
  estimate: null,
  estimateError: null,
  estimating: false,
  fillStats: null,
  submitting: false,
  cashoutError: null,
  order: null, // { depositId, amountLabel, stateLabel, explain, nextActions, txHash }
  orderNote: null,
  withdrawing: false,
  watchAbort: null,
};

// Platforms offered = catalog minus attestation-gated rails (their new
// payees need the PeerAuth browser extension; Wise and PayPal today),
// filtered to live pairs and failing open, like the Peer web express flow.
let platforms = [];
const refreshPlatforms = () => {
  const enabled = caps.platforms.filter((cap) => !cap.requiresIdentityAttestation);
  if (!state.fillStats) {
    platforms = enabled;
    return;
  }
  const live = enabled
    .map((cap) => ({
      ...cap,
      currencies: cap.currencies.filter((c) =>
        isPairLive(state.fillStats[`${cap.platform}:${c}`]),
      ),
    }))
    .filter((cap) => cap.currencies.length > 0);
  platforms = live.length > 0 ? live : enabled;
};
refreshPlatforms();

const selectedCapability = () =>
  platforms.find((c) => c.platform === state.platform) ?? platforms[0] ?? null;

const safeCurrency = () => {
  const cap = selectedCapability();
  if (!cap) return null;
  return cap.currencies.includes(state.currency)
    ? state.currency
    : cap.currencies[0] ?? null;
};

// ---------------------------------------------------------------- estimates
let estimateTimer = null;
let estimateSeq = 0;
let estimateKey = null;
const refreshEstimate = () => {
  clearTimeout(estimateTimer);
  const amount = state.amountWei;
  const currency = safeCurrency();
  if (!amount || amount < caps.amount.min || !currency) {
    state.estimate = null;
    state.estimateError = null;
    state.estimating = false;
    estimateKey = null;
    return;
  }
  const key = `${amount}:${currency}`;
  if (key === estimateKey && (state.estimate || state.estimating)) return;
  estimateKey = key;
  state.estimating = true;
  const seq = ++estimateSeq;
  estimateTimer = setTimeout(async () => {
    const settled = await cash
      .estimate({ amount, currency }, { includeEta: false })
      .then((estimate) => ({ estimate }), (error) => ({ error }));
    if (seq !== estimateSeq) return;
    state.estimate = settled.estimate ?? null;
    state.estimateError = settled.error ?? null;
    state.estimating = false;
    render();
  }, 350);
};

cash
  .fillStats()
  .then((stats) => {
    state.fillStats = stats;
    refreshPlatforms();
    render();
  })
  .catch(() => {}); // fail open: full catalog, "Varies" ETAs

// ------------------------------------------------------------------- wallet
async function ensureBaseChain(provider) {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${base.id.toString(16)}` }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: `0x${base.id.toString(16)}`,
        chainName: base.name,
        nativeCurrency: base.nativeCurrency,
        rpcUrls: [...base.rpcUrls.default.http],
        blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}

async function refreshBalance() {
  if (!state.account) {
    state.balance = null;
    return;
  }
  try {
    state.balance = await publicClient.readContract({
      address: BASE_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [state.account],
    });
  } catch {
    state.balance = null;
  }
  render();
}

function adoptAccount(address) {
  state.account = address;
  state.walletClient = address
    ? createWalletClient({
        account: address,
        chain: base,
        transport: custom(window.ethereum),
      })
    : null;
  refreshBalance();
}

async function connect() {
  if (!window.ethereum) {
    state.cashoutError = new Error(
      "No wallet found. Open this page in a browser with an EVM wallet, or in your wallet app's browser.",
    );
    render();
    return;
  }
  try {
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts',
    });
    await ensureBaseChain(window.ethereum);
    adoptAccount(accounts[0] ?? null);
    state.cashoutError = null;
  } catch (error) {
    state.cashoutError = error;
  }
  render();
}

if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', (accounts) =>
    adoptAccount(accounts[0] ?? null),
  );
  window.ethereum.on('chainChanged', () => refreshBalance());
}

// ------------------------------------------------------------------ cashout
async function submitCashout() {
  const amount = state.amountWei;
  const cap = selectedCapability();
  const currency = safeCurrency();
  if (!amount || !cap || !currency || !state.walletClient || state.submitting) {
    return;
  }
  state.submitting = true;
  state.cashoutError = null;
  render();
  try {
    const result = await cash.cashout(
      {
        amount,
        receive: { platform: cap.platform, currency, payee: state.payee.trim() },
      },
      { signer: state.walletClient },
    );
    adoptOrder({
      depositId: result.depositId,
      amountLabel: formatUsdc(amount),
      order: result.order,
      txHash: result.txHash ?? null,
    });
    refreshBalance();
    watchOrder(result.depositId);
  } catch (error) {
    state.cashoutError = error;
  } finally {
    state.submitting = false;
    render();
  }
}

function adoptOrder({ depositId, amountLabel, order, txHash }) {
  state.order = {
    depositId,
    amountLabel,
    stateLabel: formatOrderStateLabel(order?.state) ?? 'Awaiting buyer',
    explain: order?.explain?.() ?? null,
    nextActions: order?.nextActions ?? ['wait', 'withdraw'],
    txHash,
  };
  state.orderNote = null;
}

// Live order state: everything is resumable from the depositId alone, so the
// watcher is best-effort; if the iterator drops, "Refresh status" re-reads.
async function watchOrder(depositId) {
  state.watchAbort?.abort();
  const controller = new AbortController();
  state.watchAbort = controller;
  const stale = () =>
    controller.signal.aborted || state.order?.depositId !== depositId;
  try {
    for await (const order of cash.watch(depositId, {
      signal: controller.signal,
    })) {
      if (stale()) return;
      state.order.stateLabel = formatOrderStateLabel(order.state);
      state.order.explain = order.explain?.() ?? null;
      state.order.nextActions = order.nextActions ?? [];
      render();
      if (order.state === 'delivered' || order.state === 'returned') return;
    }
  } catch {
    if (stale()) return;
    state.orderNote =
      'Live status updates paused. The order is safe onchain. Refresh status any time.';
    render();
  }
}

// Read one order from the chain and show it; shared by refresh and resume.
async function loadOrder(depositId, { amountLabel = null, txHash = null } = {}) {
  const order = await cash.order(depositId);
  adoptOrder({ depositId, amountLabel, order, txHash });
  render();
  watchOrder(depositId);
}

async function refreshOrder() {
  if (!state.order) return;
  const { depositId, amountLabel, txHash } = state.order;
  try {
    await loadOrder(depositId, { amountLabel, txHash });
  } catch (error) {
    state.orderNote = cashErrorMessage(error);
    render();
  }
}

async function withdrawOrder() {
  if (!state.order || !state.walletClient || state.withdrawing) return;
  state.withdrawing = true;
  state.orderNote = null;
  render();
  try {
    await cash.withdraw(state.order.depositId, { signer: state.walletClient });
    state.orderNote = 'Withdraw submitted. Your USDC returns to your wallet.';
    refreshBalance();
    refreshOrder();
  } catch (error) {
    state.orderNote = cashErrorMessage(error);
  } finally {
    state.withdrawing = false;
    render();
  }
}

async function resumeOrder() {
  const depositId = prompt(
    'Deposit ID to resume (an order rebuilds from the chain by its ID alone):',
  );
  if (!depositId?.trim()) return;
  try {
    await loadOrder(depositId.trim());
  } catch (error) {
    state.cashoutError = error;
    render();
  }
}

function resetForm() {
  state.watchAbort?.abort();
  state.order = null;
  state.orderNote = null;
  state.amount = '';
  state.amountWei = null;
  state.payee = '';
  state.estimate = null;
  state.cashoutError = null;
  $('amount').value = '';
  render();
}

// ---------------------------------------------------------------------- cta
const cta = () => {
  if (state.submitting) {
    return { text: 'Starting cash-out…', disabled: true, action: null };
  }
  if (!state.account) {
    return { text: 'Connect wallet', disabled: false, action: connect };
  }
  const amount = state.amountWei;
  if (!state.amount.trim() || amount == null) {
    return { text: 'Enter an amount', disabled: true, action: null };
  }
  if (amount < caps.amount.min) {
    return {
      text: `Minimum cash-out is ${formatUsdc(caps.amount.min)} USDC`,
      disabled: true,
      action: null,
    };
  }
  if (state.balance != null && amount > state.balance) {
    return { text: 'Insufficient USDC balance', disabled: true, action: null };
  }
  if (!state.payee.trim()) {
    const cap = selectedCapability();
    return {
      text: `Enter your ${cap ? payeeLabel(cap.platform) : 'account'}`,
      disabled: true,
      action: null,
    };
  }
  return { text: 'Start cash-out', disabled: false, action: submitCashout };
};

// ------------------------------------------------------------------- render
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const setText = (id, text) => {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
};
const show = (id, visible) => $(id).classList.toggle('hide', !visible);
// One writer for the toggling message slots: hidden when empty.
const setNote = (id, text) => {
  show(id, Boolean(text));
  setText(id, text ?? '');
};
const syncSelect = (id, options, selected) => {
  const select = $(id);
  const signature = options.map((o) => o.value).join();
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      ...options.map((o) => new Option(o.label, o.value)),
    );
  }
  if (selected != null) select.value = selected;
};

function render() {
  const inOrder = Boolean(state.order);
  show('form', !inOrder);
  show('success', inOrder);
  setText('connect', state.account ? short(state.account) : 'Connect');

  if (inOrder) {
    const o = state.order;
    setText('orderAmount', o.amountLabel ? `${o.amountLabel} USDC` : '');
    setText('orderState', `Status: ${o.stateLabel ?? 'Pending'}`);
    setText('orderExplain', o.explain ?? '');
    setText('orderId', o.depositId);
    show('orderTx', Boolean(o.txHash));
    if (o.txHash) $('orderTx').href = `${EXPLORER}/tx/${o.txHash}`;
    setNote('orderNote', state.orderNote);
    show('withdraw', o.nextActions.includes('withdraw'));
    const withdrawButton = $('withdraw');
    withdrawButton.disabled = state.withdrawing || !state.account;
    setText('withdraw', state.withdrawing ? 'Withdrawing…' : 'Withdraw USDC');
    return;
  }

  const cap = selectedCapability();
  const currency = safeCurrency();
  syncSelect(
    'platform',
    platforms.map((c) => ({ value: c.platform, label: platformName(c.platform) })),
    cap?.platform,
  );
  syncSelect(
    'currency',
    (cap?.currencies ?? []).map((c) => ({ value: c, label: c })),
    currency,
  );

  setText(
    'balance',
    state.account && state.balance != null
      ? `Balance: ${fmt2.format(Number(formatUsdc(state.balance)))}`
      : '',
  );
  show('max', Boolean(state.account && state.balance != null && state.balance > 0n));
  const hint = (cap && PAYEE_HINTS[cap.platform]) ?? cap?.payeeHint ?? 'Enter account';
  if ($('payee').placeholder !== hint) $('payee').placeholder = hint;

  const amount = state.amountWei;
  const showEstimate = Boolean(amount && amount >= caps.amount.min && currency);
  setText(
    'receive',
    !showEstimate || (!state.estimate && !state.estimating)
      ? '0.00'
      : state.estimate
        ? fmt2.format(state.estimate.receiveAmount)
        : '…',
  );

  show('details', showEstimate);
  if (showEstimate) {
    setText(
      'rate',
      state.estimate ? `${fmt4.format(state.estimate.rate)} ${currency}/USDC` : '…',
    );
    const stats = cap && currency
      ? state.fillStats?.[`${cap.platform}:${currency}`]
      : null;
    setText('eta', formatCompactEta(stats?.medianFillSeconds) ?? 'Varies');
  }

  show(
    'minHint',
    Boolean(amount && amount >= caps.amount.min && amount < caps.amount.recommendedMin),
  );
  const error = state.cashoutError ?? state.estimateError;
  setNote('error', error ? cashErrorMessage(error) : null);

  const config = cta();
  setText('cta', config.text);
  $('cta').disabled = config.disabled;
}

// -------------------------------------------------------------------- wire
// Form edits share one tail: clear the error, refresh, render once.
const wire = (id, type, mutate) => {
  $(id).addEventListener(type, (event) => {
    mutate(event);
    state.cashoutError = null;
    refreshEstimate();
    render();
  });
};
wire('amount', 'input', (event) => {
  const value = event.target.value.replace(/[^0-9.]/g, '');
  if ((value.match(/\./g) ?? []).length > 1) return;
  state.amount = value;
  event.target.value = value;
  try {
    const parsed = /^\d*(\.\d*)?$/.test(value) ? parseUnits(value, USDC_DECIMALS) : null;
    state.amountWei = parsed > 0n ? parsed : null;
  } catch {
    state.amountWei = null;
  }
});
wire('max', 'click', () => {
  if (state.balance == null || state.balance <= 0n) return;
  state.amount = formatUsdc(state.balance);
  state.amountWei = state.balance;
  $('amount').value = state.amount;
});
wire('platform', 'change', (event) => {
  state.platform = event.target.value;
  state.currency = null;
  state.payee = '';
  $('payee').value = '';
});
wire('currency', 'change', (event) => {
  state.currency = event.target.value;
});
wire('payee', 'input', (event) => {
  state.payee = event.target.value;
});
$('connect').addEventListener('click', () => {
  if (!state.account) connect();
});
$('cta').addEventListener('click', () => cta().action?.());
$('withdraw').addEventListener('click', withdrawOrder);
$('refreshOrder').addEventListener('click', refreshOrder);
$('again').addEventListener('click', resetForm);
$('resume').addEventListener('click', resumeOrder);

// contract self-reference in the footer
if (!PAGE_ADDRESS.startsWith('__')) {
  setText('pageAddress', PAGE_ADDRESS);
  $('gateway').href = `https://${PAGE_ADDRESS.toLowerCase()}.8453.w3link.io/`;
} else {
  setText('pageAddress', 'not yet deployed · preview build');
}
setNote(
  'minHint',
  `Minimum recommended cash-out is ${formatUsdc(caps.amount.recommendedMin)} USDC`,
);
show('minHint', false);

render();
