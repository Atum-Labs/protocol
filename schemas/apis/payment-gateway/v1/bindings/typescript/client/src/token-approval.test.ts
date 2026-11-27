import { MaxUint256 } from 'ethers';
import { ensureSourceApproval, needsSourceApproval } from './index';
import type { TronWebLike } from './index';

// The per-chain matrix lives in the shared token-approval package, which owns the logic. What
// this asserts is that this package's public surface reaches that implementation.
//
// Driven through the TRON path on purpose: it takes an injected TronWeb, so the whole flow runs
// with no module mocking and no chain.

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const TRON = { network: 'tron:shasta', token: 'TToken', owner: 'TOwner' };
const TRON_SHASTA_PERMIT2 = 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp';

function fakeTronWeb(allowance: bigint): {
  tronWeb: TronWebLike;
  approve: jest.Mock;
} {
  const approve = jest.fn(() => ({ call: async () => 0n, send: async () => 'tronTx' }));
  const contract = {
    allowance: () => ({ call: async () => allowance, send: async () => 'unused' }),
    approve,
  };
  return {
    approve,
    tronWeb: {
      contract: () => contract,
      trx: { getTransactionInfo: async () => ({ receipt: { result: 'SUCCESS' } }) },
    } as unknown as TronWebLike,
  };
}

describe('source-token approval', () => {
  it('is exported from the package entry point', () => {
    expect(typeof ensureSourceApproval).toBe('function');
    expect(typeof needsSourceApproval).toBe('function');
  });

  it('reports no approval needed on Solana, without touching a chain', async () => {
    await expect(
      ensureSourceApproval({ network: SOLANA, token: 'mint', owner: 'acct' }),
    ).resolves.toEqual({ alreadySufficient: true });
    await expect(
      needsSourceApproval({ network: SOLANA, token: 'mint', owner: 'acct' }),
    ).resolves.toBe(false);
  });

  it('approves through an injected TronWeb against the pinned Permit2 for the network', async () => {
    const { tronWeb, approve } = fakeTronWeb(0n);
    await expect(ensureSourceApproval({ ...TRON, tronWeb })).resolves.toEqual({
      alreadySufficient: false,
      txHash: 'tronTx',
    });
    expect(approve).toHaveBeenCalledWith(TRON_SHASTA_PERMIT2, MaxUint256.toString());
  });

  // Permit2 decrements the allowance on every payment, so an unlimited approval is never
  // exactly MaxUint256 again after the first one.
  it('treats an unlimited allowance decremented by earlier payments as sufficient', async () => {
    const { tronWeb, approve } = fakeTronWeb(MaxUint256 - 10_000_000n);
    await expect(ensureSourceApproval({ ...TRON, tronWeb })).resolves.toEqual({
      alreadySufficient: true,
    });
    expect(approve).not.toHaveBeenCalled();
  });

  it('names the signer an EVM source needs rather than failing inside ethers', async () => {
    await expect(
      ensureSourceApproval({ network: 'eip155:8453', token: '0xToken', owner: '0xOwner' }),
    ).rejects.toThrow(/needs an ethers signer/);
  });

  it('names the TronWeb instance a Tron source needs', async () => {
    await expect(ensureSourceApproval(TRON)).rejects.toThrow(/needs a TronWeb instance/);
  });
});
