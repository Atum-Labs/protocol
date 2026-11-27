import { describe, expect, it } from 'vitest';

import { buildExtrasPolicies, validateExtras, type ExtrasBuildContext } from './extras-policies';

const CTX: ExtrasBuildContext = {
  chainKeyToChainId: {
    Arbitrum: 'eip155:421614',
    Polygon: 'eip155:80002',
    Tron: 'tron:shasta',
    Solana: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  },
  solanaMintsByChainKey: {},
};

function cond(policies: Awaited<ReturnType<typeof buildExtrasPolicies>>, name: string) {
  return policies.find((p) => p.policyName === name)?.condition;
}

describe('buildExtrasPolicies — EVM gas/fee caps', () => {
  it('emits maxGasLimit / maxFeePerGasWei conditions matching the live policy shape', async () => {
    const out = await buildExtrasPolicies(
      { evmCaps: { Arbitrum: { maxGasLimit: 1_000_000, maxFeePerGasWei: '100000000000' } } },
      CTX,
    );
    expect(cond(out, 'maxGasLimit (eip155:421614)')).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 421614 && eth.tx.gas > 1000000",
    );
    expect(cond(out, 'maxFeePerGasWei (eip155:421614)')).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 421614 && (eth.tx.max_fee_per_gas > 100000000000 || eth.tx.gas_price > 100000000000)",
    );
  });
});

describe('buildExtrasPolicies — ERC-20 recipient allowlist', () => {
  it('slices data[34..74] / data[98..138] and lowercases + strips 0x', async () => {
    const out = await buildExtrasPolicies(
      { allowedErc20Recipients: { Polygon: ['0x551DfeD720649704E79f4aa6ee6a227ce0139796'] } },
      CTX,
    );
    expect(cond(out, 'allowedErc20Recipients/transfer (eip155:80002)')).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 80002 && eth.tx.function_signature == '0xa9059cbb' && !(eth.tx.data[34..74] in ['551dfed720649704e79f4aa6ee6a227ce0139796'])",
    );
    expect(cond(out, 'allowedErc20Recipients/transferFrom (eip155:80002)')).toContain(
      "!(eth.tx.data[98..138] in ['551dfed720649704e79f4aa6ee6a227ce0139796'])",
    );
  });
});

describe('buildExtrasPolicies — TRC-20 recipient allowlist', () => {
  it('reverses Tron base58 to 20-byte hex and slices data[32..72] / data[96..136]', async () => {
    const out = await buildExtrasPolicies(
      { allowedTrc20Recipients: { Tron: ['TJPx3UdLcMmdaXKiZUvVKjK7VjaNGMU95u'] } },
      CTX,
    );
    expect(cond(out, 'allowedTrc20Recipients/transfer (tron:shasta)')).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.any(c, c.type == 'TriggerSmartContract' && c.data[0..8] == 'a9059cbb' && !(c.data[32..72] in ['5c6eeb331607af15b8883dd393e6aebea116b7ae']))",
    );
  });
});

describe('buildExtrasPolicies — Tron fee cap', () => {
  it('caps tron.tx.fee_limit', async () => {
    const out = await buildExtrasPolicies({ tronCaps: { Tron: { maxFeeLimitSun: '1000000000' } } }, CTX);
    expect(cond(out, 'maxFeeLimitSun (tron:shasta)')).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.fee_limit > 1000000000",
    );
  });
});

describe('buildExtrasPolicies — guards', () => {
  it('throws on an unknown chain key', async () => {
    await expect(
      buildExtrasPolicies({ evmCaps: { Nowhere: { maxGasLimit: 1 } } }, CTX),
    ).rejects.toThrow(/references chain key "Nowhere"/);
  });

  it('throws when a cap chain resolves to the wrong namespace', async () => {
    await expect(
      buildExtrasPolicies({ evmCaps: { Tron: { maxGasLimit: 1 } } }, CTX),
    ).rejects.toThrow(/only applies to eip155:/);
  });

  it('throws when allowedSplRecipients has no configured mints', async () => {
    await expect(
      buildExtrasPolicies(
        { allowedSplRecipients: { Solana: ['GkSfBCCMPVJSszofGR3M3XV8ELZXAEN8XVJVgkLXz7R5'] } },
        CTX,
      ),
    ).rejects.toThrow(/at least one asset mint/);
  });
});

describe('validateExtras', () => {
  it('rejects a malformed EVM recipient address', () => {
    expect(() => validateExtras({ allowedErc20Recipients: { Polygon: ['0xnope'] } })).toThrow(
      /invalid address/,
    );
  });

  it('rejects a non-integer maxGasLimit', () => {
    expect(() => validateExtras({ evmCaps: { Polygon: { maxGasLimit: 1.5 } } })).toThrow(
      /positive integer/,
    );
  });

  it('rejects an unknown top-level key (operator typo)', () => {
    // `evmCap` instead of `evmCaps`: a silent ignore would drop the operator's gas cap.
    expect(() => validateExtras({ evmCap: { Polygon: { maxGasLimit: 1_000_000 } } })).toThrow(
      /unknown key/,
    );
  });
});
