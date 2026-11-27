import { describe, it, expect, vi } from 'vitest';
import { MaxUint256 } from 'ethers';
import type { TronWebLike } from '@atum-labs/payment-request-token-approval';

import { ensureSourceApproval, isUnconfirmed, needsSourceApproval } from './index';

// The exhaustive per-chain matrix lives in the shared token-approval package, which owns the
// logic. What matters here is that this package's public surface reaches that implementation.
//
// These exercise it through the TRON path on purpose: it takes an injected TronWeb, so the
// whole flow runs with no module mocking. (A vi.mock('ethers') here would not reach the shared
// package anyway -- vitest does not transform node_modules, so the EVM path inside it would
// still build a real Contract.)

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const TRON = { network: 'tron:mainnet', token: 'TToken', owner: 'TOwner' };
const TRON_MAINNET_PERMIT2 = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';

function fakeTronWeb(allowance: bigint): {
  tronWeb: TronWebLike;
  approve: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  // `approve` also records the constant-call probe the adapter makes before broadcasting, so
  // `send` is what counts actual transactions.
  const send = vi.fn(async () => 'tronTx');
  const approve = vi.fn(() => ({ call: async () => true, send }));
  const contract = {
    allowance: () => ({ call: async () => allowance, send: async () => 'unused' }),
    approve,
  };
  return {
    approve,
    send,
    tronWeb: {
      contract: () => contract,
      trx: { getTransactionInfo: async () => ({ receipt: { result: 'SUCCESS' } }) },
    } as unknown as TronWebLike,
  };
}

describe('ensureSourceApproval', () => {
  it('is re-exported from this package, not redefined in it', () => {
    expect(typeof ensureSourceApproval).toBe('function');
    expect(typeof needsSourceApproval).toBe('function');
  });

  // Without this reaching integrators, the only way to tell a broadcast-but-unseen approval from
  // a failed one is an undocumented property on the error.
  it('exposes isUnconfirmed, so a timed-out approval is not mistaken for a failed one', () => {
    expect(isUnconfirmed(Object.assign(new Error('not confirmed'), { unconfirmed: true }))).toBe(
      true,
    );
    expect(isUnconfirmed(new Error('execution reverted'))).toBe(false);
  });

  it('is a no-op on Solana (the deposit authorizes the transfer itself)', async () => {
    const r = await ensureSourceApproval({ network: SOLANA, token: 'mint', owner: 'acct' });
    expect(r).toEqual({ alreadySufficient: true });
  });

  it('approves through the injected TronWeb, against the pinned Permit2 for the network', async () => {
    const { tronWeb, approve } = fakeTronWeb(0n);
    const r = await ensureSourceApproval({ ...TRON, tronWeb });
    expect(r).toEqual({ alreadySufficient: false, txHash: 'tronTx' });
    expect(approve).toHaveBeenCalledWith(TRON_MAINNET_PERMIT2, MaxUint256.toString());
  });

  // The reported defect, checked end to end through this package's export: Permit2 decrements
  // the allowance on every payment, so an unlimited approval is never exactly MaxUint256 again.
  it('treats an unlimited allowance decremented by earlier payments as sufficient', async () => {
    const { tronWeb, approve } = fakeTronWeb(MaxUint256 - 10_000_000n);
    expect(await ensureSourceApproval({ ...TRON, tronWeb })).toEqual({ alreadySufficient: true });
    expect(approve).not.toHaveBeenCalled();
  });

  it('approves when a stale smaller allowance does not cover this charge', async () => {
    const { tronWeb, send } = fakeTronWeb(1n);
    const r = await ensureSourceApproval({ ...TRON, tronWeb, requiredAllowance: 100n });
    expect(r).toEqual({ alreadySufficient: false, txHash: 'tronTx' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('names the signer an EVM source needs, rather than failing inside ethers', async () => {
    await expect(
      ensureSourceApproval({ network: 'eip155:8453', token: '0xToken', owner: '0xOwner' }),
    ).rejects.toThrow(/needs an ethers signer/);
  });

  it('names the TronWeb instance a Tron source needs', async () => {
    await expect(ensureSourceApproval(TRON)).rejects.toThrow(/needs a TronWeb instance/);
  });
});

describe('needsSourceApproval', () => {
  it('reports that an approval is due without sending one', async () => {
    const { tronWeb, approve } = fakeTronWeb(0n);
    expect(await needsSourceApproval({ ...TRON, tronWeb })).toBe(true);
    expect(approve).not.toHaveBeenCalled();
  });

  it('reports false once the allowance suffices', async () => {
    const { tronWeb } = fakeTronWeb(MaxUint256);
    expect(await needsSourceApproval({ ...TRON, tronWeb })).toBe(false);
  });

  it('reports false on Solana, which has no allowance to grant', async () => {
    expect(await needsSourceApproval({ network: SOLANA, token: 'mint', owner: 'a' })).toBe(false);
  });
});
