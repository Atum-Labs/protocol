import { describe, expect, it } from 'vitest';

import { buildVerifierPolicies } from './verifier-policies';
import type { VerifierExtras } from './verifier-policies';

const ARB = 'eip155:42161';
const TRON = 'tron:mainnet';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_SIGNER = 'VerifierSo1anaAccount11111111111111111111';

const chains = [
  { key: 'Arbitrum', kind: 'evm' as const, chainId: ARB },
  { key: 'Tron', kind: 'tron' as const, chainId: TRON },
  { key: 'Solana', kind: 'solana' as const, chainId: SOLANA },
];

const extras: VerifierExtras = {
  escrows: {
    Arbitrum: ['0xAbCdEf0000000000000000000000000000000001'],
    Tron: ['TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E'],
  },
  releasers: {
    Arbitrum: ['0xFeDcBa0000000000000000000000000000000002'],
    Tron: ['0xFeDcBa0000000000000000000000000000000002'],
  },
  solanaSigners: { Solana: [SOLANA_SIGNER] },
};

const byName = (name: string) => {
  const p = buildVerifierPolicies(extras, chains).find((x) => x.policyName === name);
  if (!p) throw new Error(`no policy ${name}`);
  return p;
};

describe('buildVerifierPolicies', () => {
  it('emits one release and one refund allow per secp256k1 chain, told apart only by primary type', () => {
    const release = byName(`allowReleaseWitness (${ARB})`).condition;
    const refund = byName(`allowRefundWitness (${ARB})`).condition;
    expect(release).toContain("eth.eip_712.primary_type == 'ReleaseWitness'");
    expect(refund).toContain("eth.eip_712.primary_type == 'RefundWitness'");
    expect(release.replace('ReleaseWitness', 'RefundWitness')).toBe(refund);
  });

  it('binds the escrow domain and the releaser in lowercase, the form the backend sends', () => {
    const c = byName(`allowReleaseWitness (${ARB})`).condition;
    expect(c).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_EIP712'");
    expect(c).toContain("activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'");
    expect(c).toContain("eth.eip_712.domain.name == 'Escrow'");
    expect(c).toContain("eth.eip_712.domain.version == '3'");
    expect(c).toContain('eth.eip_712.domain.chain_id == 42161');
    expect(c).toContain(
      "eth.eip_712.domain.verifying_contract in ['0xabcdef0000000000000000000000000000000001']",
    );
    expect(c).toContain(
      "eth.eip_712.message['releaser'] in ['0xfedcba0000000000000000000000000000000002']",
    );
  });

  it('writes the Tron escrow as the 0x hex its TIP-712 domain carries, under the masked chain id', () => {
    const c = byName(`allowReleaseWitness (${TRON})`).condition;
    expect(c).toContain('eth.eip_712.domain.chain_id == 728126428');
    expect(c).toMatch(/verifying_contract in \['0x[0-9a-f]{40}'\]/);
    expect(c).not.toContain('TD5g');
  });

  it('allows ed25519 raw signing only as HEXADECIMAL + NOT_APPLICABLE when Solana is configured', () => {
    const c = byName('allowEd25519RawPayload').condition;
    expect(c).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'");
    expect(c).toContain("activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'");
    const noSolana = buildVerifierPolicies(extras, chains.slice(0, 2));
    expect(noSolana.some((p) => p.policyName === 'allowEd25519RawPayload')).toBe(false);
  });

  it('denies every digest-signing hash function, delegation, batches and transaction signing', () => {
    expect(byName('denyNonTypedDataHashFunctions').condition).toContain(
      "['HASH_FUNCTION_NO_OP', 'HASH_FUNCTION_SHA256', 'HASH_FUNCTION_KECCAK256']",
    );
    expect(byName('denyAccountDelegationEncoding').effect).toBe('EFFECT_DENY');
    expect(byName('denyBatchRawPayloads').effect).toBe('EFFECT_DENY');
    expect(byName('denySignTransaction').condition).toContain('ACTIVITY_TYPE_SIGN_TRANSACTION_V2');
  });

  it('allows the two verdicts on EVM chains only, bound to the Atum Verdict domain and chain id', () => {
    const fulfillment = byName(`allowFulfillmentVerdict (${ARB})`).condition;
    const deposit = byName(`allowDepositVerdict (${ARB})`).condition;
    expect(fulfillment).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_EIP712'");
    expect(fulfillment).toContain("activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'");
    expect(fulfillment).toContain("eth.eip_712.primary_type == 'FulfillmentVerdict'");
    expect(fulfillment).toContain("eth.eip_712.domain.name == 'Atum Verdict'");
    expect(fulfillment).toContain("eth.eip_712.domain.version == '1'");
    expect(fulfillment).toContain('eth.eip_712.domain.chain_id == 42161');
    expect(fulfillment.replace('FulfillmentVerdict', 'DepositVerdict')).toBe(deposit);
    const names = buildVerifierPolicies(extras, chains).map((p) => p.policyName);
    expect(names).not.toContain(`allowFulfillmentVerdict (${TRON})`);
    expect(names).not.toContain(`allowDepositVerdict (${TRON})`);
  });

  it('emits no allow that is not a typed-data witness, a verdict or the ed25519 payload', () => {
    const allows = buildVerifierPolicies(extras, chains).filter((p) => p.effect === 'EFFECT_ALLOW');
    expect(allows.map((p) => p.policyName).sort()).toEqual(
      [
        'allowEd25519RawPayload',
        `allowDepositVerdict (${ARB})`,
        `allowFulfillmentVerdict (${ARB})`,
        `allowRefundWitness (${ARB})`,
        `allowRefundWitness (${TRON})`,
        `allowReleaseWitness (${ARB})`,
        `allowReleaseWitness (${TRON})`,
      ].sort(),
    );
  });

  it('refuses a secp256k1 chain without escrows or releasers rather than dropping the clause', () => {
    expect(() =>
      buildVerifierPolicies({ ...extras, escrows: { Tron: extras.escrows.Tron! } }, chains),
    ).toThrow(/"Arbitrum" has no escrows/);
    expect(() =>
      buildVerifierPolicies({ ...extras, releasers: { Arbitrum: extras.releasers.Arbitrum! } }, chains),
    ).toThrow(/"Tron" has no releasers/);
  });

  it('refuses a malformed EVM address and a Tron address with a bad checksum', () => {
    expect(() =>
      buildVerifierPolicies({ ...extras, escrows: { ...extras.escrows, Arbitrum: ['0x1234'] } }, chains),
    ).toThrow(/not a 20-byte 0x hex address/);
    expect(() =>
      buildVerifierPolicies(
        { ...extras, escrows: { ...extras.escrows, Tron: ['TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4F'] } },
        chains,
      ),
    ).toThrow(/checksum/);
  });

  it('refuses the zero-address placeholder on EVM and Tron, where base58 decodes to zero', () => {
    expect(() =>
      buildVerifierPolicies(
        { ...extras, releasers: { ...extras.releasers, Arbitrum: ['0x0000000000000000000000000000000000000000'] } },
        chains,
      ),
    ).toThrow(/zero address in releasers/);
    expect(() =>
      buildVerifierPolicies(
        { ...extras, releasers: { ...extras.releasers, Tron: ['T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'] } },
        chains,
      ),
    ).toThrow(/zero address in releasers/);
  });

  it('emits no consensus clause, so a non-root request is allowed or denied and never left pending', () => {
    for (const p of buildVerifierPolicies(extras, chains)) expect(p.consensus).toBeUndefined();
  });

  it('scopes the ed25519 raw allow to the verifier Solana account', () => {
    expect(byName('allowEd25519RawPayload').condition).toContain(
      `wallet_account.address in ['${SOLANA_SIGNER}']`,
    );
  });

  it('refuses a Solana chain without a signer, or with the placeholder', () => {
    expect(() => buildVerifierPolicies({ ...extras, solanaSigners: {} }, chains)).toThrow(
      /"Solana" has no solanaSigners/,
    );
    expect(() =>
      buildVerifierPolicies(
        { ...extras, solanaSigners: { Solana: ['11111111111111111111111111111111'] } },
        chains,
      ),
    ).toThrow(/not a usable Solana account address/);
  });

  it('denies credential changes so a stolen credential cannot add its own key', () => {
    const p = byName('denyCredentialChanges');
    expect(p.effect).toBe('EFFECT_DENY');
    expect(p.condition).toBe("activity.resource == 'CREDENTIAL'");
  });
});
