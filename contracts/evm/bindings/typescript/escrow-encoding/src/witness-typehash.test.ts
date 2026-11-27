/**
 * Ties every witness type map in this package to the escrow contract source.
 *
 * The oracle is contracts/evm/source/src/Escrow.sol, scanned at test time: its `*_WITNESS_TYPE_HASH`
 * constants are private, so they are not in the compiler-emitted ABI, and a typehash written into
 * this file would only agree with the map it was computed from. Every helper throws on a missing
 * file, on zero matches and on more than one match, and the scanner tests below prove it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AbiCoder, TypedDataEncoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import {
  PERMIT_WITNESS_TYPES_WITH_DESTINATION,
  REFUND_WITNESS_TYPES_WITH_QUOTE_HASH,
  RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH,
  RESERVE_WITNESS_TYPES_WITH_QUOTE_SOURCE,
} from './permit-types';
import { buildReserveTypedDataWithQuoteSource } from './reserve-encoder';
import { buildReleaseTypedDataWithQuoteHash } from './release-encoder';
import { buildRefundTypedDataWithQuoteHash } from './refund-encoder';
import {
  MAX_DESTINATION_BYTES,
  createPermitWitnessTransferFromPrehashWithDestination,
} from './deposit-encoder';
import { DEPOSIT_WITNESS_TYPE_HASH, DIRECT_DEPOSIT_DOMAIN_TAG } from './direct-deposit-encoder';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The contract this package encodes for. An ordinary tracked file, not a
 * submodule, so the read resolves in CI even though the TypeScript lane checks
 * out without `submodules: recursive`.
 */
const ESCROW_SOURCE_PATH = resolve(__dirname, '../../../../source/src/Escrow.sol');

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
 * would happily match a COMMENT — including a leftover "previously was 0x…" note
 * — and pass while the real constant had already moved. Commented-out old
 * declarations are the same hole.
 *
 * A comment becomes ONE SPACE rather than being deleted, so it can never fuse the
 * tokens on either side of it into a single identifier, and a line comment's
 * terminating newline is preserved so line structure survives. String literals
 * are respected: a `//` or `/*` inside a string never starts a comment, and a
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
 * Four properties make this a declaration scan rather than a text search, and all
 * four are load-bearing:
 *  1. `constant` is required, and is itself left-anchored — prose or a string that
 *     happens to read `NAME = 0x…` is not a candidate.
 *  2. the name is anchored against identifier characters on BOTH sides, so a
 *     search for `RESERVE_WITNESS_TYPE_HASH` can never be satisfied by a
 *     hypothetical `FULL_RESERVE_WITNESS_TYPE_HASH`.
 *  3. a BARE `=` is required. `NAME == 0x…` cannot match, because after the first
 *     `=` the pattern needs `0x` and finds `=`, and `\s*` cannot consume it.
 *  4. exactly 64 hex digits, with a trailing negative lookahead so a 65-digit
 *     literal is NOT quietly truncated to a plausible-looking value — it yields
 *     zero matches, and zero matches is a loud failure.
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
 * concatenation (`"a" "b"` is one string), because a future reformat of
 * Escrow.sol could split the long witness type string across lines and this guard
 * must survive that without being rewritten.
 *
 * Throws on a backslash escape rather than guessing: no current constant contains
 * one, and silently mis-decoding an escape would make the guard compare the wrong
 * bytes. Extend the decoder if that day comes — do not transcribe the value here.
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

/** Escrow.sol, comments stripped. Read once; a missing file throws (fail closed). */
const escrowSource = codeOnly(readFileSync(ESCROW_SOURCE_PATH, 'utf8'));

function requireExactlyOne<T>(matches: T[], constantName: string, kind: string): T {
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly ONE \`constant ${constantName} = …\` ${kind} declaration in ` +
        `${ESCROW_SOURCE_PATH} (comments excluded), found ${matches.length}. ` +
        'Zero means it was renamed, removed, or is no longer a `constant` — the guard has lost ' +
        'its oracle and must fail, not pass. More than one means the name is declared twice and ' +
        'this guard cannot tell which value ships.',
    );
  }
  return matches[0];
}

/** The typehash the CONTRACT declares. The oracle for everything below. */
function declaredTypeHash(constantName: string): string {
  return requireExactlyOne(
    findDeclaredTypeHashes(escrowSource, constantName),
    constantName,
    'bytes32',
  );
}

/** The type string the CONTRACT declares. */
function declaredString(constantName: string): string {
  return requireExactlyOne(findDeclaredStrings(escrowSource, constantName), constantName, 'string');
}

/** keccak256 of the EIP-712 encodeType for `primaryType`, i.e. its typehash. */
function typeHashOf(types: Record<string, { name: string; type: string }[]>, primaryType: string) {
  return keccak256(toUtf8Bytes(TypedDataEncoder.from(types).encodeType(primaryType)));
}

// ---------------------------------------------------------------------------
// The guards.
// ---------------------------------------------------------------------------

describe('witness typehashes are tied to Escrow.sol', () => {
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

  // Release and refund are member-for-member identical, so the ONLY thing keeping
  // a release signature from being replayed as a refund is the struct name inside
  // the type string. Assert the two hashes differ, so a copy-paste that leaves
  // `primaryType: 'ReleaseWitness'` in the refund module cannot pass by matching
  // the other witness's contract constant.
  it('release and refund typehashes are distinct despite identical members', () => {
    const release = declaredTypeHash('RELEASE_WITNESS_TYPE_HASH');
    const refund = declaredTypeHash('REFUND_WITNESS_TYPE_HASH');
    expect(release).not.toBe(refund);
    const memberList = (t: { name: string; type: string }[]) => t.map((m) => `${m.type} ${m.name}`);
    expect(memberList(REFUND_WITNESS_TYPES_WITH_QUOTE_HASH.RefundWitness)).toEqual(
      memberList(RELEASE_WITNESS_TYPES_WITH_QUOTE_HASH.ReleaseWitness),
    );
  });
});

describe('Permit2 deposit witness stays in lockstep with FULL_DEPOSIT_WITNESS_TYPE_STRING', () => {
  // Escrow.sol hands Permit2 its own FULL_DEPOSIT_WITNESS_TYPE_STRING while this
  // package hands the signer a types map, and Permit2 receives the witness as an
  // OPAQUE bytes32 — it cannot detect a disagreement between the two. If they
  // describe different structs, every deposit reverts and no fork test can catch
  // it (see the warning in test/Escrow.canonicalDigest.t.sol). This is the guard
  // for that: the string the contract passes must be the tail of the type string
  // `ethers` derives from our map.
  it('the derived PermitWitnessTransferFrom type string ends with the contract string', () => {
    const encoded = TypedDataEncoder.from(PERMIT_WITNESS_TYPES_WITH_DESTINATION).encodeType(
      'PermitWitnessTransferFrom',
    );
    expect(encoded.endsWith(declaredString('FULL_DEPOSIT_WITNESS_TYPE_STRING'))).toBe(true);
  });

  // The prefix `ethers` puts in front of that tail is Permit2's own witness-typehash stub. Permit2
  // is a submodule this lane does not check out, so the stub is also pinned by the Go-produced
  // deposit digest golden in deposit-encoder.test.ts.
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

  // A typehash comparison sees member NAMES, ORDER and TYPES. It cannot see that
  // `destination` is a dynamic member, and getting that wrong is the difference
  // between a working deposit and an unrecoverable one: Escrow.sol writes
  // keccak256(bytes(destination)) explicitly, and warns that passing the raw
  // string emits offset+len+data and "matches no signer".
  it('hashes destination as keccak256(bytes(destination)), not as inline data', () => {
    const witness = {
      depositRequestHash: '0x' + '11'.repeat(32),
      destination:
        'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
      reserver: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
      releaser: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
    };
    const fromEthers = TypedDataEncoder.from(PERMIT_WITNESS_TYPES_WITH_DESTINATION).hashStruct(
      'DepositWitness',
      witness,
    );
    // Exactly what Escrow.sol computes at its deposit use site.
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

  it('is byte-sensitive to destination casing (the base58 carve-out is why)', () => {
    const base = {
      chainId: 1,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      token: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
      amount: '1000000000000000000000',
      spender: '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0',
      nonce: 1n,
      deadline: 1770395075n,
      depositRequestHash: '0x' + '22'.repeat(32),
      destination: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v@7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv',
      reserver: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
      releaser: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
    };
    const lowered = { ...base, destination: base.destination.toLowerCase() };
    const digest = (p: typeof base) => {
      const prehash = createPermitWitnessTransferFromPrehashWithDestination(p);
      return TypedDataEncoder.hash(prehash.domain, prehash.types, prehash.message);
    };
    expect(digest(lowered)).not.toBe(digest(base));
  });
});

describe('digests reproduce the contract computation field-for-field', () => {
  // A typehash guard proves the type STRING is right. It cannot prove the builder
  // put the right VALUE in each slot: swap `quoteHash` and `depositRequestHash` in
  // the message object and every typehash test still passes, because both are
  // bytes32 and the type string never changes. So recompute each digest the way
  // Escrow.sol does — abi.encode of the SOURCE-EXTRACTED typehash followed by the
  // members in the order the contract's use site lists them — and compare.
  //
  // Argument orders below are read from contracts/evm/source/src/Escrow.sol:
  // RESERVE at the reserve verification block, RELEASE and REFUND at their
  // structHash blocks. That is a second, independent expression of the ordering:
  // for a mistake to survive, the builder and this test must be wrong identically.
  const ESCROW = '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0';
  const CHAIN_ID = 8453;

  function eip712Digest(domain: Record<string, unknown>, structHash: string): string {
    return keccak256(concat(['0x1901', TypedDataEncoder.hashDomain(domain), structHash]));
  }

  const witness = {
    depositId: '0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac',
    quoteHash: '0x419d1a281d76364f19f4141f885f05041e7c8fba624fa727fe087fa48af2cb1c',
    depositRequestHash: '0x' + 'a1'.repeat(32),
    destinationHash: '0x' + 'b2'.repeat(32),
    depositor: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
    token: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
    amount: 1_000_000n,
    feeAmount: 2_500n,
    reserver: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
    releaser: '0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7',
    settler: '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0',
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
      sourceAmount: 1_000_000n,
    };
    const prehash = buildReserveTypedDataWithQuoteSource(input);
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
      eip712Digest(prehash.domain, structHash),
    );
  });

  it('release digest equals abi.encode(RELEASE_WITNESS_TYPE_HASH, …eleven members)', () => {
    const prehash = buildReleaseTypedDataWithQuoteHash({
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
      eip712Digest(prehash.domain, structHash),
    );
  });

  it('refund digest equals abi.encode(REFUND_WITNESS_TYPE_HASH, …eleven members)', () => {
    const prehash = buildRefundTypedDataWithQuoteHash({
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
      eip712Digest(prehash.domain, structHash),
    );
  });

  it('a release digest is not a valid refund digest for the same witness', () => {
    const common = { escrowContract: ESCROW, chainId: CHAIN_ID, witness };
    const release = buildReleaseTypedDataWithQuoteHash(common);
    const refund = buildRefundTypedDataWithQuoteHash(common);
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
    chainId: 1,
    verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    token: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
    amount: '1000000000000000000000',
    spender: '0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0',
    nonce: 1n,
    deadline: 1770395075n,
    depositRequestHash: '0x' + '22'.repeat(32),
    reserver: '0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb',
    releaser: '0x83743f550bcdb5bE905766E2E3CB9a86c6823cC9',
  };

  it('refuses an empty destination (keccak256("") is a valid bytes32)', () => {
    expect(() =>
      createPermitWitnessTransferFromPrehashWithDestination({ ...validParams, destination: '' }),
    ).toThrow(/DestinationCannotBeEmpty/);
  });

  it('accepts exactly the bound and refuses one byte over', () => {
    expect(() =>
      createPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'a'.repeat(MAX_DESTINATION_BYTES),
      }),
    ).not.toThrow();
    expect(() =>
      createPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'a'.repeat(MAX_DESTINATION_BYTES + 1),
      }),
    ).toThrow(/DestinationTooLong/);
  });

  it('counts BYTES, not code points (Solidity measures bytes(destination).length)', () => {
    // 256 two-byte characters is 512 bytes: a code-point check would wave it through
    // and the contract would revert.
    expect(() =>
      createPermitWitnessTransferFromPrehashWithDestination({
        ...validParams,
        destination: 'e\u0301'.repeat(MAX_DESTINATION_BYTES / 2),
      }),
    ).toThrow(/DestinationTooLong/);
  });
});

describe('the source scanner fails closed', () => {
  it('finds no declaration for a name Escrow.sol does not declare', () => {
    expect(findDeclaredTypeHashes(escrowSource, 'NOT_A_REAL_TYPE_HASH')).toEqual([]);
    // …and the helper every guard actually calls turns that into a failure rather
    // than a skip or an undefined comparison.
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
    expect(() => requireExactlyOne(findDeclaredTypeHashes(doubled, 'X_TYPE_HASH'), 'X', 'bytes32')).toThrow(
      /found 2/,
    );
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

  it('keeps string literals intact through codeOnly, including // inside them', () => {
    const src = 'string constant S = "a//b/*c*/d"; // trailing\n';
    expect(findDeclaredStrings(codeOnly(src), 'S')).toEqual(['a//b/*c*/d']);
  });

  it('joins Solidity adjacent string literals', () => {
    const src = 'string private constant S =\n  "Deposit" "Witness(";';
    expect(findDeclaredStrings(src, 'S')).toEqual(['DepositWitness(']);
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

describe('direct deposit constants are tied to Escrow.sol', () => {
  it('DIRECT_DEPOSIT_DOMAIN_TAG equals the contract constant', () => {
    expect(DIRECT_DEPOSIT_DOMAIN_TAG).toBe(declaredTypeHash('DIRECT_DEPOSIT_DOMAIN_TAG'));
  });

  it('DEPOSIT_WITNESS_TYPE_HASH equals the contract constant', () => {
    expect(DEPOSIT_WITNESS_TYPE_HASH).toBe(declaredTypeHash('DEPOSIT_WITNESS_TYPE_HASH'));
  });
});
