import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  createPermitWitnessTransferFromPrehashWithDestination,
  hashPermitWitnessTransferFrom,
  PERMIT2_CONTRACT_ADDRESS,
} from './deposit-encoder';
import { PERMIT_WITNESS_TYPES_WITH_DESTINATION } from './permit-types';

// Oracle: the digest the Go encoder's DigestWithDestination produces for the same inputs, pinned by
// TestDepositWithDestinationGolden in ../../go/encoding/deposit_witness_v2_test.go.
const ORACLE = {
  chainId: 1,
  verifyingContract: PERMIT2_CONTRACT_ADDRESS,
  token: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
  amount: '1000000000000000000000',
  spender: '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0',
  nonce: 1n,
  deadline: 1770395075n,
  depositRequestHash: keccak256(toUtf8Bytes('req-golden')),
  destination:
    'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
  reserver: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
  releaser: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
  expectedDigest: '0x3eba91739f468207bafeebfba019e10750b13dc5ad645a53d391bb8e778e8ff6',
};

describe('createPermitWitnessTransferFromPrehashWithDestination + hashPermitWitnessTransferFrom', () => {
  it('matches the Go encoder digest', () => {
    const prehash = createPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(hashPermitWitnessTransferFrom(prehash)).toBe(ORACLE.expectedDigest);
  });

  it('serializes chainId as a lowercase hex string', () => {
    const prehash = createPermitWitnessTransferFromPrehashWithDestination({ ...ORACLE, chainId: 8453 });
    expect(prehash.domain.chainId).toBe('0x2105');
  });

  it('keeps the serialized key order', () => {
    const prehash = createPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(Object.keys(prehash)).toEqual(['types', 'primaryType', 'domain', 'message']);
    expect(Object.keys(prehash.message.witness)).toEqual([
      'depositRequestHash',
      'destination',
      'reserver',
      'releaser',
    ]);
  });

  it('uses the shared witness types and omits an explicit EIP712Domain', () => {
    const prehash = createPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(prehash.types).toBe(PERMIT_WITNESS_TYPES_WITH_DESTINATION);
    expect('EIP712Domain' in prehash.types).toBe(false);
  });

  it('stringifies numeric fields as decimal strings', () => {
    const prehash = createPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(prehash.message.nonce).toBe('1');
    expect(prehash.message.deadline).toBe('1770395075');
    expect(prehash.message.permitted.amount).toBe('1000000000000000000000');
  });

  it('is sensitive to the chain id and to every byte of the destination', () => {
    const base = hashPermitWitnessTransferFrom(createPermitWitnessTransferFromPrehashWithDestination(ORACLE));
    const otherChain = hashPermitWitnessTransferFrom(
      createPermitWitnessTransferFromPrehashWithDestination({ ...ORACLE, chainId: 137 }),
    );
    const otherDestination = hashPermitWitnessTransferFrom(
      createPermitWitnessTransferFromPrehashWithDestination({ ...ORACLE, destination: ORACLE.destination.toUpperCase() }),
    );
    expect(otherChain).not.toBe(base);
    expect(otherDestination).not.toBe(base);
  });
});
