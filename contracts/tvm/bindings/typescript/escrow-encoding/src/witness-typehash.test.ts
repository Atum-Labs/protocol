/**
 * Ties every witness type map in this package to the TVM escrow contract source.
 *
 * The oracle is contracts/tvm/source/contracts/Escrow.sol, scanned at test time: its
 * `*_WITNESS_TYPE_HASH` constants are private, so they are not in the compiler-emitted ABI, and a
 * typehash written into this file would only agree with the map it was computed from. Every helper
 * throws on a missing file, on zero matches and on more than one match, and the scanner tests below
 * prove it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AbiCoder, TypedDataEncoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import {
  RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
  buildTvmReserveTypedDataWithQuoteSource,
} from './reserve-encoder';
import {
  RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
  buildTvmReleaseTypedDataWithQuoteHash,
} from './release-encoder';
import {
  REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
  buildTvmRefundTypedDataWithQuoteHash,
} from './refund-encoder';
import {
  MAX_DESTINATION_BYTES,
  PERMIT_WITNESS_TYPES_WITH_DESTINATION,
  createTvmPermitWitnessTransferFromPrehashWithDestination,
} from './deposit-encoder';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The Tron contract this package encodes for. An ordinary tracked file, not a
 * submodule, so the read resolves in CI even though the TypeScript lane checks out
 * without `submodules: recursive`.
 */
const ESCROW_SOURCE_PATH = resolve(__dirname, '../../../../source/contracts/Escrow.sol');

/**
 * The EVM contract, used only by the cross-VM guard at the end. The four witness
 * type strings are supposed to be BYTE-IDENTICAL across the two chains — a
 * TVM-only divergence is a bug, not a Tron quirk — and nothing else in either
 * package checks that claim.
 */
const EVM_ESCROW_SOURCE_PATH = resolve(__dirname, '../../../../../evm/source/src/Escrow.sol');

// ---------------------------------------------------------------------------
// The source scanner. A faithful port of _codeOnly + _findDeclaredTypeHash from
// contracts/evm/source/test/EncodingExamples.verify.t.sol.
// ---------------------------------------------------------------------------

/**
 * `source` with every comment replaced by a single space, so a scan over the
 * result can only match real code.
 *
 * This step is not cosmetic, it is the whole reason the scan is trustworthy.
 * Escrow.sol carries a `keccak256("ReleaseWitness(…)")` natspec comment directly
 * above each constant, so a naive
 *   /RELEASE_WITNESS_TYPE_HASH\s*=\s*(0x[0-9a-f]{64})/
 * would happily match a COMMENT — including a leftover "previously was 0x…" note —
 * and pass while the real constant had already moved.
 *
 * A comment becomes ONE SPACE rather than being deleted, so it can never fuse the
 * tokens on either side of it into a single identifier, and a line comment's
 * terminating newline is preserved so line structure survives. String literals are
 * respected: a `//` or `/*` inside a string never starts a comment, and a
 * backslash-escaped quote never ends the string.
 */
function codeOnly(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\' && i + 1 < source.length) {
          i++;
          out += source[i]; // escaped character: never a terminator
        } else if (source[i] === quote) {
          break;
        }
        i++;
      }
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += ' ';
      if (i < source.length) out += '\n';
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++; // land on the closing '/', which the loop's own i++ then steps past
      out += ' ';
      continue;
    }

    out += c;
  }
  return out;
}

/** Identifier characters, used to anchor a constant name on both sides. */
const IDENT = '[0-9A-Za-z_]';

/**
 * Scans comment-stripped Solidity for a `constant <name> = 0x<64 hex>`
 * DECLARATION and returns EVERY match, so the caller can require exactly one.
 *
 * Four properties make this a declaration scan rather than a text search:
 *  1. `constant` is required and is itself left-anchored, so prose or a string that
 *     happens to read `NAME = 0x…` is not a candidate.
 *  2. the name is anchored against identifier characters on BOTH sides, so a search
 *     for `DEPOSIT_WITNESS_TYPE_HASH` can never be satisfied by
 *     `FULL_DEPOSIT_WITNESS_TYPE_HASH`.
 *  3. a BARE `=` is required — `NAME == 0x…` cannot match.
 *  4. exactly 64 hex digits, with a trailing negative lookahead so a 65-digit
 *     literal is not quietly truncated to a plausible value; it yields zero
 *     matches, and zero matches is a loud failure.
 */
function findDeclaredTypeHashes(source: string, constantName: string): string[] {
  const pattern = new RegExp(
    `(?<!${IDENT})constant\\s+${constantName}(?!${IDENT})\\s*=\\s*(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])`,
    'g',
  );
  return [...source.matchAll(pattern)].map((m) => m[1].toLowerCase());
}

/**
 * Same scan for a `string constant`. Handles Solidity's adjacent-literal
 * concatenation (`"a" "b"` is one string) so a future reformat that splits the long
 * witness type string across lines does not silently defeat the guard.
 *
 * Throws on a backslash escape rather than guessing: no current constant contains
 * one, and mis-decoding an escape would compare the wrong bytes.
 */
function findDeclaredStrings(source: string, constantName: string): string[] {
  const literal = `"(?:[^"\\\\]|\\\\.)*"`;
  const pattern = new RegExp(
    `(?<!${IDENT})constant\\s+${constantName}(?!${IDENT})\\s*=\\s*((?:${literal}\\s*)+)`,
    'g',
  );
  return [...source.matchAll(pattern)].map((m) => {
    const parts = m[1].match(new RegExp(literal, 'g')) ?? [];
    return parts
      .map((part) => {
        const inner = part.slice(1, -1);
        if (inner.includes('\\')) {
          throw new Error(
            `${constantName} contains a Solidity string escape, which this scanner does not decode. ` +
              'Extend findDeclaredStrings rather than transcribing the value into the test.',
          );
        }
        return inner;
      })
      .join('');
  });
}

/**
 * Same scan for a `uint` constant assigned a DECIMAL literal — MAX_DESTINATION_BYTES
 * is a plain `256`, not hex, so the bytes32 scanner cannot see it. Same four
 * anchoring properties, plus a trailing lookahead so `2560` cannot be read as `256`.
 */
function findDeclaredUints(source: string, constantName: string): number[] {
  const pattern = new RegExp(
    `(?<!${IDENT})constant\\s+${constantName}(?!${IDENT})\\s*=\\s*([0-9]+)(?![0-9_a-zA-Z])`,
    'g',
  );
  return [...source.matchAll(pattern)].map((m) => Number(m[1]));
}

/** Both contracts, comments stripped. A missing file throws (fail closed). */
const escrowSource = codeOnly(readFileSync(ESCROW_SOURCE_PATH, 'utf8'));
const evmEscrowSource = codeOnly(readFileSync(EVM_ESCROW_SOURCE_PATH, 'utf8'));

function requireExactlyOne<T>(matches: T[], constantName: string, kind: string, path: string): T {
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly ONE \`constant ${constantName} = …\` ${kind} declaration in ${path} ` +
        `(comments excluded), found ${matches.length}. Zero means it was renamed, removed, or is ` +
        'no longer a `constant` — the guard has lost its oracle and must fail, not pass. More than ' +
        'one means the name is declared twice and this guard cannot tell which value ships.',
    );
  }
  return matches[0];
}

/** The typehash the TRON CONTRACT declares. The oracle for everything below. */
function declaredTypeHash(constantName: string): string {
  return requireExactlyOne(
    findDeclaredTypeHashes(escrowSource, constantName),
    constantName,
    'bytes32',
    ESCROW_SOURCE_PATH,
  );
}

/** The type string the TRON CONTRACT declares. */
function declaredString(constantName: string): string {
  return requireExactlyOne(
    findDeclaredStrings(escrowSource, constantName),
    constantName,
    'string',
    ESCROW_SOURCE_PATH,
  );
}

/** keccak256 of the TIP-712 encodeType for `primaryType`, i.e. its typehash. */
function typeHashOf(types: Record<string, { name: string; type: string }[]>, primaryType: string) {
  return keccak256(toUtf8Bytes(TypedDataEncoder.from(types).encodeType(primaryType)));
}

// ---------------------------------------------------------------------------
// The guards.
// ---------------------------------------------------------------------------

describe('witness typehashes are tied to the TVM Escrow.sol', () => {
  it('DepositWitness matches DEPOSIT_WITNESS_TYPE_HASH', () => {
    expect(typeHashOf(PERMIT_WITNESS_TYPES_WITH_DESTINATION, 'DepositWitness')).toBe(
      declaredTypeHash('DEPOSIT_WITNESS_TYPE_HASH'),
    );
  });

  it('ReserveWitness matches RESERVE_WITNESS_TYPE_HASH', () => {
    expect(typeHashOf(RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE, 'ReserveWitness')).toBe(
      declaredTypeHash('RESERVE_WITNESS_TYPE_HASH'),
    );
  });

  it('ReleaseWitness matches RELEASE_WITNESS_TYPE_HASH (eleven members)', () => {
    expect(RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH.ReleaseWitness).toHaveLength(11);
    expect(typeHashOf(RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH, 'ReleaseWitness')).toBe(
      declaredTypeHash('RELEASE_WITNESS_TYPE_HASH'),
    );
  });

  it('RefundWitness matches REFUND_WITNESS_TYPE_HASH (eleven members)', () => {
    expect(REFUND_WITNESS_TYPES_WITH_QUOTE_HASH.RefundWitness).toHaveLength(11);
    expect(typeHashOf(REFUND_WITNESS_TYPES_WITH_QUOTE_HASH, 'RefundWitness')).toBe(
      declaredTypeHash('REFUND_WITNESS_TYPE_HASH'),
    );
  });

  it('release and refund typehashes are distinct despite identical members', () => {
    expect(declaredTypeHash('RELEASE_WITNESS_TYPE_HASH')).not.toBe(
      declaredTypeHash('REFUND_WITNESS_TYPE_HASH'),
    );
    const memberList = (t: { name: string; type: string }[]) => t.map((m) => `${m.type} ${m.name}`);
    expect(memberList(REFUND_WITNESS_TYPES_WITH_QUOTE_HASH.RefundWitness)).toEqual(
      memberList(RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH.ReleaseWitness),
    );
  });
});

describe('Permit2 deposit witness stays in lockstep with FULL_DEPOSIT_WITNESS_TYPE_STRING', () => {
  // Escrow.sol hands Permit2 its own FULL_DEPOSIT_WITNESS_TYPE_STRING while this
  // package hands the signer a types map, and Permit2 receives the witness as an
  // OPAQUE bytes32 — it cannot detect a disagreement. If the two describe different
  // structs, every deposit reverts and no fork test can catch it.
  it('the derived PermitWitnessTransferFrom type string ends with the contract string', () => {
    const encoded = TypedDataEncoder.from(PERMIT_WITNESS_TYPES_WITH_DESTINATION).encodeType(
      'PermitWitnessTransferFrom',
    );
    expect(encoded.endsWith(declaredString('FULL_DEPOSIT_WITNESS_TYPE_STRING'))).toBe(true);
  });

  // The prefix `ethers` puts in front of that tail is Permit2's own witness-typehash stub. Permit2
  // is not vendored on the TVM side, so the stub is also pinned by the Go-produced deposit digest
  // golden in deposit-encoder.test.ts.
  it('the derived type string starts with the Permit2 stub', () => {
    const encoded = TypedDataEncoder.from(PERMIT_WITNESS_TYPES_WITH_DESTINATION).encodeType(
      'PermitWitnessTransferFrom',
    );
    expect(
      encoded.startsWith(
        'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,',
      ),
    ).toBe(true);
  });

  // A typehash comparison cannot see that `destination` is a DYNAMIC member, and
  // getting that wrong is the difference between a working deposit and an
  // unrecoverable one: Escrow.sol writes keccak256(bytes(destination)) explicitly
  // and warns that passing the raw string emits offset+len+data and matches no signer.
  it('hashes destination as keccak256(bytes(destination)), not as inline data', () => {
    const witness = {
      depositRequestHash: '0x' + '11'.repeat(32),
      destination:
        'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
      reserver: '0xa601a68f95f0cb1ec1e186b1f4f709478bde679f',
      releaser: '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc',
    };
    const fromEthers = TypedDataEncoder.from(PERMIT_WITNESS_TYPES_WITH_DESTINATION).hashStruct(
      'DepositWitness',
      witness,
    );
    const asContract = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes32', 'bytes32', 'address', 'address'],
        [
          declaredTypeHash('DEPOSIT_WITNESS_TYPE_HASH'),
          witness.depositRequestHash,
          keccak256(toUtf8Bytes(witness.destination)),
          witness.reserver,
          witness.releaser,
        ],
      ),
    );
    expect(fromEthers).toBe(asContract);
  });

  // Tron's base58 segments are CASE-SIGNIFICANT, so the one thing the builder must
  // not do to a destination is treat it like a Tron address. If `destination` ever
  // went through normalizeAddress (or any lowercasing), a Solana or Tron
  // destination's commitment would be corrupted and the deposit stranded.
  it('leaves the destination string byte-for-byte alone, base58 casing included', () => {
    const destination =
      'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TYaKH9ApqbdftVGSnTMPVL9kp1S5AQBQSs';
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination({
      chainId: 2494104990,
      permit2Address: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      tokenAddress: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
      amount: '100000000',
      spenderAddress: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py',
      nonce: 1776340107514n,
      deadline: 1776343707n,
      depositRequestHash: '0x' + '33'.repeat(32),
      destination,
      reserverAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
      releaserAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
    });
    expect(prehash.message.witness.destination).toBe(destination);
    // …and the addresses around it ARE normalized, so this is not a no-op builder.
    expect(prehash.message.witness.reserver).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.domain.chainId).toBe('0x94a9059e');
  });
});

describe('digests reproduce the contract computation field-for-field', () => {
  // A typehash guard proves the type STRING is right. It cannot prove the builder
  // put the right VALUE in each slot: swap `quoteHash` and `depositRequestHash` in
  // the message object and every typehash test still passes, because both are
  // bytes32 and the type string never changes. So recompute each digest the way
  // Escrow.sol does — abi.encode of the SOURCE-EXTRACTED typehash followed by the
  // members in the order the contract's use site lists them — and compare.
  const ESCROW = '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc';
  const CHAIN_ID = 2494104990; // Shasta; exercises the 32-bit mask

  function tip712Digest(domain: Record<string, unknown>, structHash: string): string {
    return keccak256(concat(['0x1901', TypedDataEncoder.hashDomain(domain), structHash]));
  }

  const witness = {
    depositId: '0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc',
    quoteHash: '0x' + '4c'.repeat(32),
    depositRequestHash: '0x' + 'a1'.repeat(32),
    destinationHash: '0x' + 'b2'.repeat(32),
    depositor: '0xa601a68f95f0cb1ec1e186b1f4f709478bde679f',
    token: '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc',
    amount: 100_000_000n,
    feeAmount: 250_000n,
    reserver: '0xa601a68f95f0cb1ec1e186b1f4f709478bde679f',
    releaser: '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc',
    settler: '0xa601a68f95f0cb1ec1e186b1f4f709478bde679f',
  };

  const ELEVEN_TYPES = [
    'bytes32',
    'bytes32',
    'bytes32',
    'bytes32',
    'bytes32',
    'address',
    'address',
    'uint256',
    'uint256',
    'address',
    'address',
    'address',
  ];

  const elevenValues = (typeHash: string) => [
    typeHash,
    witness.depositId,
    witness.quoteHash,
    witness.depositRequestHash,
    witness.destinationHash,
    witness.depositor,
    witness.token,
    witness.amount,
    witness.feeAmount,
    witness.reserver,
    witness.releaser,
    witness.settler,
  ];

  it('reserve digest equals abi.encode(RESERVE_WITNESS_TYPE_HASH, depositId, quoteHash, settler, sourceAmount)', () => {
    const input = {
      escrowContract: ESCROW,
      chainId: CHAIN_ID,
      depositId: witness.depositId,
      quoteHash: witness.quoteHash,
      settler: witness.settler,
      sourceAmount: 100_000_000n,
    };
    const prehash = buildTvmReserveTypedDataWithQuoteSource(input);
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes32', 'bytes32', 'address', 'uint256'],
        [
          declaredTypeHash('RESERVE_WITNESS_TYPE_HASH'),
          input.depositId,
          input.quoteHash,
          input.settler,
          input.sourceAmount,
        ],
      ),
    );
    expect(TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message)).toBe(
      tip712Digest(prehash.domain, structHash),
    );
  });

  it('release digest equals abi.encode(RELEASE_WITNESS_TYPE_HASH, …eleven members)', () => {
    const prehash = buildTvmReleaseTypedDataWithQuoteHash({
      escrowContract: ESCROW,
      chainId: CHAIN_ID,
      witness,
    });
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ELEVEN_TYPES,
        elevenValues(declaredTypeHash('RELEASE_WITNESS_TYPE_HASH')),
      ),
    );
    expect(TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message)).toBe(
      tip712Digest(prehash.domain, structHash),
    );
  });

  it('refund digest equals abi.encode(REFUND_WITNESS_TYPE_HASH, …eleven members)', () => {
    const prehash = buildTvmRefundTypedDataWithQuoteHash({
      escrowContract: ESCROW,
      chainId: CHAIN_ID,
      witness,
    });
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ELEVEN_TYPES,
        elevenValues(declaredTypeHash('REFUND_WITNESS_TYPE_HASH')),
      ),
    );
    expect(TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message)).toBe(
      tip712Digest(prehash.domain, structHash),
    );
  });

  // Tron's TIP-712 domain uses a uint32 chainId. Signing over the unmasked value
  // produces a digest that verifies against nothing on chain, so the mask is not a
  // cosmetic detail — assert every new builder applies it.
  it('masks the chainId in every builder', () => {
    const overflowing = CHAIN_ID + 0x1_0000_0000; // same low 32 bits
    const releaseDigest = (chainId: number) => {
      const p = buildTvmReleaseTypedDataWithQuoteHash({ escrowContract: ESCROW, chainId, witness });
      return TypedDataEncoder.hash(p.domain, p.types, p.message);
    };
    expect(releaseDigest(overflowing)).toBe(releaseDigest(CHAIN_ID));
    expect(
      buildTvmRefundTypedDataWithQuoteHash({ escrowContract: ESCROW, chainId: overflowing, witness })
        .domain.chainId,
    ).toBe('0x94a9059e');
    expect(
      buildTvmReserveTypedDataWithQuoteSource({
        escrowContract: ESCROW,
        chainId: overflowing,
        depositId: witness.depositId,
        quoteHash: witness.quoteHash,
        settler: witness.settler,
        sourceAmount: 1n,
      }).domain.chainId,
    ).toBe('0x94a9059e');
  });

  it('a release digest is not a valid refund digest for the same witness', () => {
    const common = { escrowContract: ESCROW, chainId: CHAIN_ID, witness };
    const release = buildTvmReleaseTypedDataWithQuoteHash(common);
    const refund = buildTvmRefundTypedDataWithQuoteHash(common);
    expect(TypedDataEncoder.hash(release.domain, release.types, release.message)).not.toBe(
      TypedDataEncoder.hash(refund.domain, refund.types, refund.message),
    );
  });
});

describe('the destination byte bound is tied to Escrow.sol and enforced', () => {
  // The builder enforces the bound itself, and the contract's is a private constant invisible to
  // the ABI, so it is read from source like the typehashes.
  it('equals the contract constant', () => {
    const declared = requireExactlyOne(
      findDeclaredUints(escrowSource, 'MAX_DESTINATION_BYTES'),
      'MAX_DESTINATION_BYTES',
      'uint',
      ESCROW_SOURCE_PATH,
    );
    expect(MAX_DESTINATION_BYTES).toBe(declared);
  });

  it('the uint scanner fails closed and reads the WHOLE literal', () => {
    // 2560 must come back as 2560, never as a truncated 256 that happens to match
    // this package's constant — the source tie then compares 256 to 2560 and fails.
    expect(findDeclaredUints('uint256 constant X = 2560;', 'X')).toEqual([2560]);
    expect(findDeclaredUints('uint256 constant X = 256;', 'X')).toEqual([256]);
    expect(findDeclaredUints(escrowSource, 'NOT_A_REAL_BOUND')).toEqual([]);
  });

  const validParams = {
    chainId: 2494104990,
    permit2Address: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
    tokenAddress: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
    amount: '100000000',
    spenderAddress: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py',
    nonce: 1n,
    deadline: 1776343707n,
    depositRequestHash: '0x' + '22'.repeat(32),
    reserverAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
    releaserAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
  };

  it('refuses an empty destination (keccak256("") is a valid bytes32)', () => {
    expect(() =>
      createTvmPermitWitnessTransferFromPrehashWithDestination({ ...validParams, destination: '' }),
    ).toThrow(/DestinationCannotBeEmpty/);
  });

  it('accepts exactly the bound and refuses one byte over', () => {
    expect(() =>
      createTvmPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'a'.repeat(MAX_DESTINATION_BYTES),
      }),
    ).not.toThrow();
    expect(() =>
      createTvmPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'a'.repeat(MAX_DESTINATION_BYTES + 1),
      }),
    ).toThrow(/DestinationTooLong/);
  });

  it('counts BYTES, not code points (Solidity measures bytes(destination).length)', () => {
    // 256 two-byte characters is 512 bytes: a code-point check would wave it through
    // and the contract would revert.
    expect(() =>
      createTvmPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'e\u0301'.repeat(MAX_DESTINATION_BYTES / 2),
      }),
    ).toThrow(/DestinationTooLong/);
  });
});

describe('the source scanner fails closed', () => {
  it('finds no declaration for a name Escrow.sol does not declare', () => {
    expect(findDeclaredTypeHashes(escrowSource, 'NOT_A_REAL_TYPE_HASH')).toEqual([]);
    expect(() => declaredTypeHash('NOT_A_REAL_TYPE_HASH')).toThrow(/found 0/);
  });

  it('refuses a name declared twice instead of picking one', () => {
    const doubled =
      'bytes32 private constant X_TYPE_HASH = 0x' +
      '11'.repeat(32) +
      ';\nbytes32 private constant X_TYPE_HASH = 0x' +
      '22'.repeat(32) +
      ';';
    expect(findDeclaredTypeHashes(doubled, 'X_TYPE_HASH')).toHaveLength(2);
    expect(() =>
      requireExactlyOne(findDeclaredTypeHashes(doubled, 'X_TYPE_HASH'), 'X', 'bytes32', 'synthetic'),
    ).toThrow(/found 2/);
  });

  it('never reads a comment as a declaration', () => {
    const commented =
      '// bytes32 private constant X_TYPE_HASH = 0x' +
      '33'.repeat(32) +
      ';\n/* bytes32 private constant X_TYPE_HASH = 0x' +
      '44'.repeat(32) +
      '; */\n';
    expect(findDeclaredTypeHashes(codeOnly(commented), 'X_TYPE_HASH')).toEqual([]);
    // The un-stripped text WOULD match — which is exactly the hole codeOnly closes.
    expect(findDeclaredTypeHashes(commented, 'X_TYPE_HASH')).toHaveLength(2);
  });

  it('is not satisfied by a longer identifier that contains the name', () => {
    const longer = 'bytes32 private constant FULL_X_TYPE_HASH = 0x' + '55'.repeat(32) + ';';
    expect(findDeclaredTypeHashes(longer, 'X_TYPE_HASH')).toEqual([]);
    expect(findDeclaredTypeHashes(longer, 'FULL_X_TYPE_HASH')).toHaveLength(1);
  });

  it('requires the `constant` keyword and a bare `=`', () => {
    const notConstant = 'bytes32 private X_TYPE_HASH = 0x' + '66'.repeat(32) + ';';
    expect(findDeclaredTypeHashes(notConstant, 'X_TYPE_HASH')).toEqual([]);
    const comparison = 'require(constant X_TYPE_HASH == 0x' + '77'.repeat(32) + ');';
    expect(findDeclaredTypeHashes(comparison, 'X_TYPE_HASH')).toEqual([]);
  });

  it('rejects a hex literal of the wrong width rather than truncating it', () => {
    const tooLong = 'bytes32 private constant X_TYPE_HASH = 0x' + '88'.repeat(32) + '99;';
    expect(findDeclaredTypeHashes(tooLong, 'X_TYPE_HASH')).toEqual([]);
    const tooShort = 'bytes32 private constant X_TYPE_HASH = 0x' + '88'.repeat(31) + ';';
    expect(findDeclaredTypeHashes(tooShort, 'X_TYPE_HASH')).toEqual([]);
  });

  it('reads the four real typehash constants out of the real contract', () => {
    // Not a value assertion — a proof that the scanner actually engages with
    // Escrow.sol rather than every guard above passing vacuously.
    for (const name of [
      'DEPOSIT_WITNESS_TYPE_HASH',
      'RESERVE_WITNESS_TYPE_HASH',
      'RELEASE_WITNESS_TYPE_HASH',
      'REFUND_WITNESS_TYPE_HASH',
    ]) {
      expect(declaredTypeHash(name)).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(declaredString('FULL_DEPOSIT_WITNESS_TYPE_STRING')).toContain('DepositWitness witness)');
  });
});

describe('TVM and EVM witnesses are byte-identical', () => {
  // The two contracts are supposed to pin the SAME four type strings. TVM's own
  // foundry_tests/Escrow.declarationOrder.t.sol states the rule — a TVM-only
  // divergence is a bug, not a Tron quirk — but nothing checks it across the two
  // trees, and a Tron-side "fix" that renamed one member would look locally
  // consistent while splitting the protocol in half.
  it.each([
    'DEPOSIT_WITNESS_TYPE_HASH',
    'RESERVE_WITNESS_TYPE_HASH',
    'RELEASE_WITNESS_TYPE_HASH',
    'REFUND_WITNESS_TYPE_HASH',
  ])('%s is the same constant in both contracts', (name) => {
    const evm = requireExactlyOne(
      findDeclaredTypeHashes(evmEscrowSource, name),
      name,
      'bytes32',
      EVM_ESCROW_SOURCE_PATH,
    );
    expect(declaredTypeHash(name)).toBe(evm);
  });

  it('FULL_DEPOSIT_WITNESS_TYPE_STRING is the same string in both contracts', () => {
    const evm = requireExactlyOne(
      findDeclaredStrings(evmEscrowSource, 'FULL_DEPOSIT_WITNESS_TYPE_STRING'),
      'FULL_DEPOSIT_WITNESS_TYPE_STRING',
      'string',
      EVM_ESCROW_SOURCE_PATH,
    );
    expect(declaredString('FULL_DEPOSIT_WITNESS_TYPE_STRING')).toBe(evm);
  });
});
