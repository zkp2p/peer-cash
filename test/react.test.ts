import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { WalletClient } from 'viem';
import type { CashClient, CashoutInput, CashoutResult } from '../src/client/createCashClient';
import type { CashEstimate } from '../src/client/estimate';
import type { CashOrder } from '../src/engine/types';
import {
  useCashout,
  useEstimate,
  useOrder,
  useOrders,
  type UseCashoutOptions,
  type UseEstimateOptions,
  type UseOrderOptions,
  type UseOrdersOptions,
} from '../src/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function estimate(amount: bigint): CashEstimate {
  return {
    kind: 'oracle-estimate',
    currency: 'USD',
    amount,
    rate: 1,
    receiveAmount: Number(amount) / 1_000_000,
    asOf: 1_700_000_000,
  };
}

const cashoutInput: CashoutInput = {
  amount: 1_000_000n,
  receive: {
    platform: 'venmo',
    currency: 'USD',
    payee: { offchainId: 'alice' },
  },
};

const cashoutResult = {
  depositId: '0x0000000000000000000000000000000000000001_1',
  txHash: `0x${'1'.repeat(64)}`,
} as CashoutResult;

const secondCashoutResult = {
  depositId: '0x0000000000000000000000000000000000000002_2',
  txHash: `0x${'2'.repeat(64)}`,
} as CashoutResult;

function order(depositId: string): CashOrder {
  return {
    depositId,
    state: 'awaiting-buyer',
    fills: [],
    totalAmount: 1_000_000n,
    filledAmount: 0n,
    pendingAmount: 0n,
    returnedAmount: 0n,
    nextActions: ['wait', 'withdraw'],
    isInFlight: true,
    explain: () => 'Waiting for a buyer.',
  };
}

describe('@zkp2p/cash/react', () => {
  it('useEstimate can request the rate without indexer-backed ETA', async () => {
    const estimateMock = vi.fn().mockResolvedValue(estimate(1_000_000n));
    const client = { estimate: estimateMock } as unknown as CashClient;
    let renderer: ReactTestRenderer;

    function Harness() {
      useEstimate({
        client,
        amount: 1_000_000n,
        currency: 'USD',
        platform: 'venmo',
        includeEta: false,
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness));
    });

    expect(estimateMock).toHaveBeenCalledWith(
      { amount: 1_000_000n, currency: 'USD', platform: 'venmo' },
      { includeEta: false },
    );
    await act(async () => renderer.unmount());
  });

  it('useEstimate keeps the newest input when an older request resolves last', async () => {
    const first = deferred<CashEstimate>();
    const second = deferred<CashEstimate>();
    const estimateMock = vi.fn(({ amount }: { amount: bigint }) =>
      amount === 1_000_000n ? first.promise : second.promise,
    );
    const client = { estimate: estimateMock } as unknown as CashClient;
    let current: ReturnType<typeof useEstimate> | undefined;
    let renderer: ReactTestRenderer;

    function Harness(props: UseEstimateOptions) {
      current = useEstimate(props);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, amount: 1_000_000n, currency: 'USD' }));
    });
    expect(estimateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(createElement(Harness, { client, amount: 2_000_000n, currency: 'USD' }));
    });
    expect(estimateMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(estimate(2_000_000n));
      await second.promise;
    });
    expect(current?.estimate?.amount).toBe(2_000_000n);

    await act(async () => {
      first.resolve(estimate(1_000_000n));
      await first.promise;
    });
    expect(current?.estimate?.amount).toBe(2_000_000n);

    await act(async () => renderer.unmount());
  });

  it('useEstimate clears a value that belongs to a previous input', async () => {
    const nextEstimate = deferred<CashEstimate>();
    const estimateMock = vi
      .fn()
      .mockResolvedValueOnce(estimate(1_000_000n))
      .mockReturnValueOnce(nextEstimate.promise);
    const client = { estimate: estimateMock } as unknown as CashClient;
    let current: ReturnType<typeof useEstimate> | undefined;
    let renderer: ReactTestRenderer;
    const observations: Array<{ requested: bigint | null | undefined; shown?: bigint }> = [];

    function Harness(props: UseEstimateOptions) {
      current = useEstimate(props);
      observations.push({
        requested: props.amount,
        ...(current.estimate ? { shown: current.estimate.amount } : {}),
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, amount: 1_000_000n, currency: 'USD' }));
    });
    expect(current?.estimate?.amount).toBe(1_000_000n);

    await act(async () => {
      renderer.update(createElement(Harness, { client, amount: 2_000_000n, currency: 'USD' }));
    });
    expect(current?.estimate).toBeNull();
    expect(current?.isLoading).toBe(true);
    expect(
      observations.some(({ requested, shown }) => requested === 2_000_000n && shown === 1_000_000n),
    ).toBe(false);

    await act(async () => {
      nextEstimate.resolve(estimate(2_000_000n));
      await nextEstimate.promise;
    });
    await act(async () => renderer.unmount());
  });

  it('useCashout preserves a successful result when an observer callback throws', async () => {
    const client = {
      cashout: vi.fn().mockResolvedValue(cashoutResult),
    } as unknown as CashClient;
    const signer = {} as WalletClient;
    const onError = vi.fn();
    const onCashout = vi.fn(() => {
      throw new Error('consumer callback failed');
    });
    let current: ReturnType<typeof useCashout> | undefined;
    let renderer: ReactTestRenderer;

    function Harness(props: UseCashoutOptions) {
      current = useCashout(props);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, signer, onCashout, onError }));
    });

    let returned: CashoutResult | null | undefined;
    await act(async () => {
      returned = await current?.cashout(cashoutInput);
    });

    expect(returned).toBe(cashoutResult);
    expect(current?.result).toBe(cashoutResult);
    expect(current?.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
  });

  it('useCashout prevents a second submission before React can render pending state', async () => {
    const pendingCashout = deferred<CashoutResult>();
    const cashoutMock = vi.fn(() => pendingCashout.promise);
    const client = { cashout: cashoutMock } as unknown as CashClient;
    const signer = {} as WalletClient;
    let current: ReturnType<typeof useCashout> | undefined;
    let renderer: ReactTestRenderer;

    function Harness(props: UseCashoutOptions) {
      current = useCashout(props);
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, signer }));
    });

    let firstRun!: Promise<CashoutResult | null>;
    let secondRun!: Promise<CashoutResult | null>;
    act(() => {
      firstRun = current!.cashout(cashoutInput);
      secondRun = current!.cashout(cashoutInput);
    });

    expect(cashoutMock).toHaveBeenCalledTimes(1);
    await expect(secondRun).resolves.toBeNull();

    await act(async () => {
      pendingCashout.resolve(cashoutResult);
      await expect(firstRun).resolves.toBe(cashoutResult);
    });
    expect(current?.pending).toBeNull();

    await act(async () => renderer.unmount());
  });

  it('useCashout keeps mutation state scoped to the current client and signer', async () => {
    const oldCashout = deferred<CashoutResult>();
    const firstClient = {
      cashout: vi.fn(() => oldCashout.promise),
    } as unknown as CashClient;
    const secondClient = {
      cashout: vi.fn().mockResolvedValue(secondCashoutResult),
    } as unknown as CashClient;
    const firstSigner = {} as WalletClient;
    const secondSigner = {} as WalletClient;
    let current: ReturnType<typeof useCashout> | undefined;
    let renderer: ReactTestRenderer;
    const observations: Array<{ requested: 'first' | 'second'; pending: string | null }> = [];

    function Harness(props: UseCashoutOptions) {
      current = useCashout(props);
      observations.push({
        requested: props.client === firstClient ? 'first' : 'second',
        pending: current.pending,
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client: firstClient, signer: firstSigner }));
    });

    let firstRun!: Promise<CashoutResult | null>;
    act(() => {
      firstRun = current!.cashout(cashoutInput);
    });
    expect(current?.pending).toBe('cashout');

    await act(async () => {
      renderer.update(createElement(Harness, { client: secondClient, signer: secondSigner }));
    });
    expect(current?.pending).toBeNull();
    expect(current?.result).toBeNull();
    expect(
      observations.some(
        ({ requested, pending }) => requested === 'second' && pending === 'cashout',
      ),
    ).toBe(false);

    let secondRun: CashoutResult | null | undefined;
    await act(async () => {
      secondRun = await current!.cashout(cashoutInput);
    });
    expect(secondRun).toBe(secondCashoutResult);
    expect(current?.result).toBe(secondCashoutResult);

    await act(async () => {
      oldCashout.resolve(cashoutResult);
      await firstRun;
    });
    expect(current?.result).toBe(secondCashoutResult);
    expect(current?.pending).toBeNull();

    await act(async () => renderer.unmount());
  });

  it('useOrder never exposes a response from a previous deposit identity', async () => {
    const first = deferred<CashOrder>();
    const second = deferred<CashOrder>();
    const firstId = '0x0000000000000000000000000000000000000001_1';
    const secondId = '0x0000000000000000000000000000000000000001_2';
    let firstIdCalls = 0;
    const orderMock = vi.fn((depositId: string) => {
      if (depositId !== firstId) return second.promise;
      firstIdCalls += 1;
      return firstIdCalls === 1 ? Promise.resolve(order(firstId)) : first.promise;
    });
    const client = { order: orderMock } as unknown as CashClient;
    let current: ReturnType<typeof useOrder> | undefined;
    let renderer: ReactTestRenderer;
    const observations: Array<{ requested: string | null | undefined; shown?: string }> = [];

    function Harness(props: UseOrderOptions) {
      current = useOrder(props);
      observations.push({
        requested: props.depositId,
        ...(current.order ? { shown: current.order.depositId } : {}),
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, depositId: firstId, paused: true }));
    });

    await act(async () => {
      await current!.refresh();
    });
    expect(current?.order?.depositId).toBe(firstId);

    let staleRefresh!: Promise<CashOrder | null>;
    act(() => {
      staleRefresh = current!.refresh();
    });
    await act(async () => {
      renderer.update(createElement(Harness, { client, depositId: secondId, paused: true }));
    });
    expect(current?.order).toBeNull();
    expect(
      observations.some(({ requested, shown }) => requested === secondId && shown === firstId),
    ).toBe(false);

    let secondRefresh!: Promise<CashOrder | null>;
    act(() => {
      secondRefresh = current!.refresh();
    });
    await act(async () => {
      second.resolve(order(secondId));
      await secondRefresh;
    });
    expect(current?.order?.depositId).toBe(secondId);

    await act(async () => {
      first.resolve(order(firstId));
      await staleRefresh;
    });
    expect(current?.order?.depositId).toBe(secondId);

    await act(async () => renderer.unmount());
  });

  it('useOrders never exposes a response from a previous owner identity', async () => {
    const first = deferred<CashOrder[]>();
    const second = deferred<CashOrder[]>();
    const firstOwner = '0x0000000000000000000000000000000000000001';
    const secondOwner = '0x0000000000000000000000000000000000000002';
    const firstOrder = order(`${firstOwner}_1`);
    const secondOrder = order(`${secondOwner}_2`);
    let firstOwnerCalls = 0;
    const ordersMock = vi.fn((owner: string) => {
      if (owner !== firstOwner) return second.promise;
      firstOwnerCalls += 1;
      return firstOwnerCalls === 1 ? Promise.resolve([firstOrder]) : first.promise;
    });
    const client = { orders: ordersMock } as unknown as CashClient;
    let current: ReturnType<typeof useOrders> | undefined;
    let renderer: ReactTestRenderer;
    const observations: Array<{ requested: string | null | undefined; shown?: string }> = [];

    function Harness(props: UseOrdersOptions) {
      current = useOrders(props);
      observations.push({
        requested: props.owner,
        ...(current.orders[0] ? { shown: current.orders[0].depositId } : {}),
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Harness, { client, owner: firstOwner, paused: true }));
    });

    await act(async () => {
      await current!.refresh();
    });
    expect(current?.orders).toEqual([firstOrder]);

    let staleRefresh!: Promise<CashOrder[]>;
    act(() => {
      staleRefresh = current!.refresh();
    });
    await act(async () => {
      renderer.update(createElement(Harness, { client, owner: secondOwner, paused: true }));
    });
    expect(current?.orders).toEqual([]);
    expect(
      observations.some(
        ({ requested, shown }) => requested === secondOwner && shown === firstOrder.depositId,
      ),
    ).toBe(false);

    let secondRefresh!: Promise<CashOrder[]>;
    act(() => {
      secondRefresh = current!.refresh();
    });
    await act(async () => {
      second.resolve([secondOrder]);
      await secondRefresh;
    });
    expect(current?.orders).toEqual([secondOrder]);

    await act(async () => {
      first.resolve([firstOrder]);
      await staleRefresh;
    });
    expect(current?.orders).toEqual([secondOrder]);

    await act(async () => renderer.unmount());
  });

  it('useOrders keeps polling after an empty result and discovers a new order', async () => {
    vi.useFakeTimers();
    try {
      const owner = '0x0000000000000000000000000000000000000001';
      const indexedOrder = order(`${owner}_1`);
      const client = {
        orders: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([indexedOrder]),
      } as unknown as CashClient;
      let current: ReturnType<typeof useOrders> | undefined;
      let renderer: ReactTestRenderer;

      function Harness(props: UseOrdersOptions) {
        current = useOrders(props);
        return null;
      }

      await act(async () => {
        renderer = create(
          createElement(Harness, { client, owner, pollIntervalMs: 100, paused: false }),
        );
      });
      expect(current?.orders).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(current?.orders).toEqual([indexedOrder]);
      expect(client.orders).toHaveBeenCalledTimes(2);
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});
