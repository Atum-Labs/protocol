/**
 * The EVM Permit2 helpers this package re-exports are the shared encoder's own.
 */

import * as encoding from '@atum-labs/evm-escrow-encoding';
import { hashPermitWitnessTransferFrom, PERMIT2_CONTRACT_ADDRESS } from './evm_permit2';

describe('EVM Permit2 re-exports', () => {
  it('re-exports the shared digest function and Permit2 address', () => {
    expect(hashPermitWitnessTransferFrom).toBe(encoding.hashPermitWitnessTransferFrom);
    expect(PERMIT2_CONTRACT_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });

  it('hashes a four-member deposit prehash', () => {
    const prehash = encoding.createPermitWitnessTransferFromPrehashWithDestination({
      chainId: 1,
      verifyingContract: PERMIT2_CONTRACT_ADDRESS,
      token: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
      amount: '1000000',
      spender: '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0',
      nonce: 1n,
      deadline: 1924991999n,
      depositRequestHash: '0x' + '11'.repeat(32),
      destination:
        'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
      reserver: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
      releaser: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
    });
    expect(hashPermitWitnessTransferFrom(prehash)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
