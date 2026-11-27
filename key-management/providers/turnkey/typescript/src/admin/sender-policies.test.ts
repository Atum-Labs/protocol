import { describe, expect, it } from 'vitest';

import { buildEscrowDestination } from '@atum-labs/payment-request-sender-auth';

import {
  TRON_PERMIT2,
  buildSenderPolicies,
  tronBase58ToEvmHex,
  tronTip712ChainId,
} from './sender-policies';

describe('tronBase58ToEvmHex', () => {
  it('decodes a valid Tron base58check address to its 20-byte EVM hex form', () => {
    // Both Permit2 constants are the addresses buildSenderPolicies actually feeds this
    // function, so this doubles as a guard that the checksum check does not reject them.
    expect(tronBase58ToEvmHex(TRON_PERMIT2.mainnet)).toBe(
      '5fb997996f0ebf9fbe4013aa5cfa1991654a06d8',
    );
    expect(tronBase58ToEvmHex(TRON_PERMIT2.shasta)).toBe(
      '9433ffaad19a9aaff9ec184b879dd23ba5a6553d',
    );
    expect(tronBase58ToEvmHex('TFsgzfpVixWBCHEaHUsXtwe6ebVqTgbRYg')).toBe(
      '40c5a066175440cf577b80431d0ac8936212caa9',
    );
  });

  it('rejects a mistyped address whose base58check checksum no longer matches', () => {
    // TRON_PERMIT2.shasta with its final character changed (h -> q). It still decodes to
    // 25 bytes with a 0x41 prefix, so it passes the length/prefix guards and fails only the
    // checksum check — exactly the typo case a shape-only regex would let through.
    expect(() => tronBase58ToEvmHex('TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahq')).toThrow(
      /checksum/,
    );
  });

  it('rejects a string containing a non-base58 character', () => {
    expect(() => tronBase58ToEvmHex('TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe50ahp')).toThrow(
      /Invalid base58 character/,
    );
  });
});

describe('buildSenderPolicies Solana escrow programs', () => {
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const chains = [{ key: 'Solana', kind: 'solana' as const, chainId: SOLANA }];
  const extras = (solanaEscrowProgramId: string | readonly string[]) => ({
    network: 'mainnet' as const,
    allowedTokens: {},
    solanaEscrowProgramId,
  });
  const allowlist = (solanaEscrowProgramId: string | readonly string[]) =>
    buildSenderPolicies(extras(solanaEscrowProgramId), chains).find(
      (p) => p.policyName === `allowedPrograms (${SOLANA})`,
    )!.condition;

  it('allows a single program ID given as a bare string', () => {
    const cond = allowlist('AAAAescrow');
    expect(cond).toContain("'AAAAescrow'");
  });

  it('allows every program ID in a list, so one policy can cover two escrow deployments', () => {
    const cond = allowlist(['OLDescrow', 'NEWescrow']);
    expect(cond).toContain("'OLDescrow'");
    expect(cond).toContain("'NEWescrow'");
  });

  it('keeps the standard programs alongside the escrow list', () => {
    const cond = allowlist(['OLDescrow', 'NEWescrow']);
    expect(cond).toContain("'ComputeBudget111111111111111111111111111111'");
    expect(cond).toContain("'Ed25519SigVerify111111111111111111111111111'");
  });

  it('emits a repeated or blank entry exactly once', () => {
    const cond = allowlist(['DUPescrow', ' DUPescrow ', '', 'DUPescrow']);
    expect(cond.match(/'DUPescrow'/g)).toHaveLength(1);
    expect(cond).not.toContain("''");
  });

  it('throws when Solana is in the chain map but the list is empty', () => {
    expect(() => buildSenderPolicies(extras([]), chains)).toThrow(/no solanaEscrowProgramId/);
  });
});

describe('buildSenderPolicies Permit2 typed-data allow', () => {
  const BASE = 'eip155:8453';
  const TRON = 'tron:shasta';
  const ESCROW = '0xA61a0C025943Aa79B73D8D07E3aDbEe1873738b4';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const RESERVER = '0xd0f080E23F95571D26eEb1FAD24a5F3d66835195';
  const RELEASER = '0x27050EE47befC43F4dF7807a7AA8073039e5fa89';
  // Composed through the SAME function the payer signs through, not transcribed. That is the
  // point of the test: it pins the emitted literal to the producer, so a change to the casing
  // rule breaks here instead of silently denying every payment in production. The Solana one is
  // here on purpose — a Base-to-Solana payment is an EVM-source deposit whose witness carries a
  // base58 destination, and base58 is where folding does the damage.
  const DEST_EVM = buildEscrowDestination(
    `eip155:8453/erc20:${USDC}`,
    '0xc0ffee254729296a45a3885639ac7e10f9d54979',
  );
  const DEST_SOL = buildEscrowDestination(
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  );

  const chains = [{ key: 'Base', kind: 'evm' as const, chainId: BASE }];
  const extras = (over: Record<string, unknown> = {}) => ({
    network: 'mainnet' as const,
    allowedTokens: { Base: [USDC] },
    escrows: { Base: [ESCROW] },
    allowedDestinations: { Base: [DEST_EVM, DEST_SOL] },
    reservers: { Base: [RESERVER] },
    releasers: { Base: [RELEASER] },
    ...over,
  });
  const allow = (over: Record<string, unknown> = {}) =>
    buildSenderPolicies(extras(over) as never, chains).find(
      (p) => p.policyName === `allowPermit2DepositTypedData (${BASE})`,
    )!;

  it('scopes the allow to typed data, which is what makes the field conditions readable', () => {
    const c = allow().condition;
    expect(c).toContain("activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'");
    expect(c).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_EIP712'");
    expect(c).toContain("activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'");
    // The batch form is never allowed: message conditions bind only one of its payloads.
    expect(c).not.toContain('ACTIVITY_TYPE_SIGN_RAW_PAYLOADS');
  });

  it('pins the struct and the Permit2 domain', () => {
    const c = allow().condition;
    expect(c).toContain("eth.eip_712.primary_type == 'PermitWitnessTransferFrom'");
    expect(c).toContain("eth.eip_712.domain.name == 'Permit2'");
    expect(c).toContain(
      "eth.eip_712.domain.verifying_contract == '0x000000000022d473030f116ddee9f6b43ac78ba3'",
    );
    // Integer, not the hex string ethers puts on the wire — Turnkey re-parses it and refuses
    // the hex form at policy-create time.
    expect(c).toContain('eth.eip_712.domain.chain_id == 8453');
  });

  it('binds spender, which is the funds destination Permit2 leaves unsigned', () => {
    expect(allow().condition).toContain(
      `eth.eip_712.message['spender'] in ['${ESCROW.toLowerCase()}']`,
    );
  });

  it('throws when a chain has no escrow, rather than emitting an unbound allow', () => {
    expect(() => allow({ escrows: {} })).toThrow(/no escrows/);
  });

  it('binds the destination byte-for-byte, preserving base58 case', () => {
    const c = allow().condition;
    expect(c).toContain(`eth.eip_712.message['witness']['destination'] in ['${DEST_EVM}', '${DEST_SOL}']`);
    // The whole failure mode this guards: lowercasing a Solana destination corrupts its CAIP-2
    // reference, its mint and its account at once, producing a value that matches nothing.
    expect(c).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('throws when a chain has no destinations', () => {
    expect(() => allow({ allowedDestinations: {} })).toThrow(/no allowedDestinations/);
  });

  it('rejects a destination that is not composed, or that would break out of the literal', () => {
    expect(() => allow({ allowedDestinations: { Base: ['0xc0ffee'] } })).toThrow(/not a composed/);
    expect(() => allow({ allowedDestinations: { Base: [`${DEST_EVM}'`] } })).toThrow(/quote/);
    const tooLong = `eip155:8453/erc20:${USDC}@0x${'a'.repeat(250)}`;
    expect(() => allow({ allowedDestinations: { Base: [tooLong] } })).toThrow(/longer than/);
  });

  it('binds both witness roles, and refuses to emit an allow that leaves either unbound', () => {
    const c = allow().condition;
    expect(c).toContain(`eth.eip_712.message['witness']['reserver'] in ['${RESERVER.toLowerCase()}']`);
    expect(c).toContain(`eth.eip_712.message['witness']['releaser'] in ['${RELEASER.toLowerCase()}']`);
    // Silently dropping the clause would leave the settlement-diversion hole open behind a
    // policy set that looks complete, so an empty list is an error rather than a wider allow.
    expect(() => allow({ reservers: {} })).toThrow(/no reservers/);
    expect(() => allow({ releasers: {} })).toThrow(/no releasers/);
  });

  it('binds the permitted token', () => {
    expect(allow().condition).toContain(
      `eth.eip_712.message['permitted']['token'] in ['${USDC.toLowerCase()}']`,
    );
  });

  it('uses the Tron Permit2 deployment and its masked TIP-712 chain id', () => {
    const policies = buildSenderPolicies(
      {
        network: 'testnet',
        allowedTokens: { Tron: ['TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'] },
        // Base58 on purpose: the emitter must convert these to the TIP-712 message form while
        // the calldata policy keeps the base58 spelling.
        escrows: { Tron: ['TFsgzfpVixWBCHEaHUsXtwe6ebVqTgbRYg'] },
        allowedDestinations: { Tron: [DEST_EVM] },
        reservers: { Tron: [RESERVER] },
        releasers: { Tron: [RELEASER] },
      } as never,
      [{ key: 'Tron', kind: 'tron' as const, chainId: TRON }],
    );
    const c = policies.find((p) => p.policyName === `allowPermit2DepositTypedData (${TRON})`)!.condition;
    expect(c).toContain(`eth.eip_712.domain.verifying_contract == '0x${tronBase58ToEvmHex(TRON_PERMIT2.shasta)}'`);
    expect(c).toContain('eth.eip_712.domain.chain_id == 2494104990');
    // Address MEMBERS are hex on Tron: the TIP-712 message strips the 0x41 prefix. A base58
    // literal here would match nothing, while the calldata policy below still needs base58.
    const tokenHex = tronBase58ToEvmHex('TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs');
    expect(c).toContain(`eth.eip_712.message['permitted']['token'] in ['0x${tokenHex}']`);
    expect(c).not.toContain('TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs');
    // A base58 spender is converted too, not just the token.
    expect(c).toContain(
      `eth.eip_712.message['spender'] in ['0x${tronBase58ToEvmHex('TFsgzfpVixWBCHEaHUsXtwe6ebVqTgbRYg')}']`,
    );
    // …while the calldata policy still matches the base58 contract address on the wire.
    const approve = policies.find((p) => p.policyName === `allowApproveToPermit2 (${TRON})`)!;
    expect(approve.condition).toContain("'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'");
  });

  it('rejects a Tron address that is neither base58 nor 20-byte hex', () => {
    expect(() =>
      buildSenderPolicies(
        {
          network: 'testnet',
          allowedTokens: { Tron: ['not-an-address'] },
          escrows: { Tron: [ESCROW] },
          allowedDestinations: { Tron: [DEST_EVM] },
          reservers: { Tron: [RESERVER] },
          releasers: { Tron: [RELEASER] },
        } as never,
        [{ key: 'Tron', kind: 'tron' as const, chainId: TRON }],
      ),
    ).toThrow(/neither a base58/);
  });

  it('refuses a Tron cluster that disagrees with the configured network', () => {
    // The two Tron domain values come from different places: the Permit2 deployment from
    // `network`, the chain id from the CAIP-2. Pairing them across clusters emits a domain no
    // signature can match, so it is refused rather than emitted.
    expect(() =>
      buildSenderPolicies({ ...extras(), network: 'testnet' } as never, [
        { key: 'Base', kind: 'tron' as const, chainId: 'tron:mainnet' },
      ]),
    ).toThrow(/selects the shasta Permit2 deployment/);
    expect(() =>
      buildSenderPolicies(extras() as never, [
        { key: 'Base', kind: 'tron' as const, chainId: 'tron:nile' },
      ]),
    ).toThrow(/is "tron:nile"/);
  });

  it('maps both known Tron clusters to their masked TIP-712 chain id', () => {
    expect(tronTip712ChainId('tron:mainnet')).toBe(728126428);
    expect(tronTip712ChainId('tron:shasta')).toBe(2494104990);
    expect(() => tronTip712ChainId('tron:nile')).toThrow(/unsupported Tron network/);
  });

  it('measures the destination cap in UTF-8 bytes, not characters', () => {
    // The escrow's DestinationTooLong check counts bytes, so a multibyte string can sit under the
    // character count and still be unredeemable.
    const multibyte = `eip155:8453/erc20:${USDC}@${'é'.repeat(120)}`;
    expect(multibyte.length).toBeLessThan(256);
    expect(() => allow({ allowedDestinations: { Base: [multibyte] } })).toThrow(/longer than/);
  });

  it('honours a non-canonical Permit2 in BOTH the permit and the approve policy', () => {
    // Half-honouring it would produce a sub-org that can sign a permit for an address it is not
    // allowed to approve.
    const alt = '0x00000000000000000000000000000000000ca11e';
    const policies = buildSenderPolicies(extras({ permit2: alt }) as never, chains);
    expect(
      policies.find((p) => p.policyName === `allowPermit2DepositTypedData (${BASE})`)!.condition,
    ).toContain(`eth.eip_712.domain.verifying_contract == '${alt}'`);
    expect(
      policies.find((p) => p.policyName === `allowApproveToPermit2 (${BASE})`)!.condition,
    ).toContain(`eth.tx.data[34..74] == '${alt.replace(/^0x/, '')}'`);
  });
});

describe('buildSenderPolicies raw-signing denies', () => {
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const build = (chains: { key: string; kind: 'evm' | 'tron' | 'solana'; chainId: string }[]) =>
    buildSenderPolicies(
      {
        network: 'mainnet',
        allowedTokens: {},
        escrows: {},
        allowedDestinations: {},
        solanaEscrowProgramId: 'AAAAescrow',
      } as never,
      chains,
    );
  const solanaOnly = () => build([{ key: 'Solana', kind: 'solana', chainId: SOLANA }]);

  it('denies KECCAK256, the sign-any-preimage path that reproduces an EIP-712 digest', () => {
    const p = solanaOnly().find((x) => x.policyName === 'denyNonTypedDataHashFunctions')!;
    expect(p.effect).toBe('EFFECT_DENY');
    expect(p.condition).toContain('HASH_FUNCTION_KECCAK256');
    expect(p.condition).toContain('HASH_FUNCTION_NO_OP');
    expect(p.condition).toContain('HASH_FUNCTION_SHA256');
  });

  it('denies the 7702 encoding, a one-signature account takeover', () => {
    const p = solanaOnly().find((x) => x.policyName === 'denyAccountDelegationEncoding')!;
    expect(p.effect).toBe('EFFECT_DENY');
    expect(p.condition).toContain('PAYLOAD_ENCODING_EIP7702_AUTHORIZATION');
  });

  it('denies the batch raw-payload form', () => {
    const p = solanaOnly().find((x) => x.policyName === 'denyBatchRawPayloads')!;
    expect(p.effect).toBe('EFFECT_DENY');
    expect(p.condition).toBe("activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'");
  });

  it('allows raw ed25519 signing only when the sub-org actually holds a Solana chain', () => {
    const p = solanaOnly().find((x) => x.policyName === 'allowEd25519RawPayload')!;
    expect(p.effect).toBe('EFFECT_ALLOW');
    expect(p.condition).toContain("activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'");
    expect(p.condition).toContain('PAYLOAD_ENCODING_HEXADECIMAL');

    const noSolana = build([]);
    expect(noSolana.find((x) => x.policyName === 'allowEd25519RawPayload')).toBeUndefined();
  });

  it('no longer emits the blanket raw-payload allow', () => {
    expect(solanaOnly().find((x) => x.policyName === 'allowSignRawPayload')).toBeUndefined();
  });
});

describe('typedDataOnlyRawSigningDenies', () => {
  // The live sender sub-orgs carry these exact conditions. apply-policies compares name, effect and
  // condition, so any change here is drift that forces --update on every sender sub-org.
  const LIVE_SENDER_DENIES = [
    [
      'denyNonTypedDataHashFunctions',
      "activity.type in ['ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'] && activity.params.hash_function in ['HASH_FUNCTION_NO_OP', 'HASH_FUNCTION_SHA256', 'HASH_FUNCTION_KECCAK256']",
    ],
    [
      'denyAccountDelegationEncoding',
      "activity.type in ['ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'] && activity.params.encoding == 'PAYLOAD_ENCODING_EIP7702_AUTHORIZATION'",
    ],
    ['denyBatchRawPayloads', "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'"],
  ];

  it('keeps the sender set byte-identical to what is live', () => {
    const emitted = buildSenderPolicies(
      { network: 'mainnet', allowedTokens: {}, solanaEscrowProgramId: 'AAAAescrow' },
      [{ key: 'Solana', kind: 'solana', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }],
    );
    for (const [name, condition] of LIVE_SENDER_DENIES) {
      const p = emitted.find((x) => x.policyName === name);
      expect(p?.effect).toBe('EFFECT_DENY');
      expect(p?.condition).toBe(condition);
    }
  });
});
