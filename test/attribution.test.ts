import { describe, expect, it, vi } from 'vitest';
import { readCashAttributedDepositIds } from '../src/client/attribution';

describe('Peer Cash deposit attribution', () => {
  it('normalizes and de-duplicates ids before querying', async () => {
    const query = vi.fn(async () => ({ Deposit: [{ id: '0xABC_1' }, { id: '' }] }));

    const ids = await readCashAttributedDepositIds({ query }, ['0xABC_1', '0xabc_1', '0xDEF_2']);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['0xabc_1', '0xdef_2'] } }),
    );
    expect(ids).toEqual(new Set(['0xabc_1']));
  });

  it('does not query an empty id set', async () => {
    const query = vi.fn();
    await expect(readCashAttributedDepositIds({ query }, [])).resolves.toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });
});
