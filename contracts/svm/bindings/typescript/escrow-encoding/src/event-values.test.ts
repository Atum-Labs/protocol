/**
 * scripts/lib/event-values.mjs: checks an emitted event's field VALUES against what the same
 * transaction shows independently -- the token transfers it made, the balances before it, the
 * instruction's args and accounts -- so a field the committed IDL puts at the wrong offset is
 * caught even when the payload length matches. Fixtures are real mainnet v4 transactions.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import { checkValues, crossCheck, summarize } from '../scripts/lib/event-values.mjs';
import { findProgramAddress } from '../scripts/lib/pda.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const load = (path: string) => JSON.parse(readFileSync(resolve(here, path), 'utf8'));
const escrowIdl = load('./generated/escrow.json');
const proxyIdl = load('./generated/fulfillment_proxy.json');
const ESCROW = '5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx';
const PROXY = 'CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ';

/** The transaction with one emitted event's payload rewritten, as a drifted program would emit it. */
function withPayload(tx: any, eventIndex: number, edit: (payload: Buffer) => void) {
  const copy = structuredClone(tx);
  const lines: string[] = copy.meta.logMessages;
  const at = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('Program data: '))[
    eventIndex
  ][1];
  const payload = Buffer.from(lines[at].slice('Program data: '.length), 'base64');
  edit(payload);
  lines[at] = `Program data: ${payload.toString('base64')}`;
  return copy;
}

/** Swap two equal-width fields in place: the payload length, and so the length check, is unchanged. */
const swap = (payload: Buffer, a: number, b: number, width: number) => {
  const first = Buffer.from(payload.subarray(a, a + width));
  payload.copy(payload, a, b, b + width);
  first.copy(payload, b);
};

const key = (n: number) => bs58.encode(Buffer.alloc(32, n));
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const discriminatorOf = (list: { name: string; discriminator: number[] }[], name: string) =>
  Buffer.from(list.find((x) => x.name === name)!.discriminator);

/**
 * A minimal jsonParsed transaction: one program instruction, the token transfers it made as inner
 * instructions, and the event it emitted. For events no mainnet transaction has emitted yet.
 */
function syntheticTx(opts: {
  programId: string;
  data: Buffer;
  accounts: string[];
  transfers: { source: string; destination: string; amount: bigint }[];
  event: Buffer;
  balancesBefore?: Record<string, bigint>;
}) {
  const before = Object.entries(opts.balancesBefore ?? {});
  return {
    transaction: {
      message: {
        accountKeys: before.map(([account]) => account),
        instructions: [
          { programId: opts.programId, accounts: opts.accounts, data: bs58.encode(opts.data) },
        ],
      },
    },
    meta: {
      preTokenBalances: before.map(([, amount], accountIndex) => ({
        accountIndex,
        uiTokenAmount: { amount: String(amount) },
      })),
      innerInstructions: [
        {
          index: 0,
          instructions: opts.transfers.map((t) => ({
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            stackHeight: 2,
            parsed: {
              type: 'transferChecked',
              info: { ...t, tokenAmount: { amount: String(t.amount) } },
            },
          })),
        },
      ],
      logMessages: [
        `Program ${opts.programId} invoke [1]`,
        `Program data: ${opts.event.toString('base64')}`,
        `Program ${opts.programId} success`,
      ],
    },
  };
}

describe('checkValues: Released', () => {
  const { tx } = load('../testdata/mainnet-v4-release.json');

  it('agrees with the transfers out of the escrow ATA and its balance before the release', () => {
    const [released] = checkValues(escrowIdl, ESCROW, tx);
    expect(released.name).toBe('Released');
    expect(released.mismatches).toEqual([]);
    expect(Object.keys(released.results).sort()).toEqual(
      [
        'deposit_hash',
        'fee_amount',
        'gross_amount',
        'intended_amount',
        'net_amount',
        'recipient',
        'surplus_amount',
      ].sort(),
    );
  });

  // Offsets after the 8-byte discriminator: deposit_hash 0, recipient 32, gross 64, intended 72,
  // surplus 80, fee 88, net 96, quote_hash 104.
  it('catches fee_amount and surplus_amount swapped at equal length', () => {
    const drifted = withPayload(tx, 0, (p) => swap(p, 8 + 80, 8 + 88, 8));
    const [released] = checkValues(escrowIdl, ESCROW, drifted);
    expect(released.mismatches.map((m: { field: string }) => m.field).sort()).toEqual([
      'fee_amount',
      'surplus_amount',
    ]);
  });

  // If the emitting instruction cannot be found -- its discriminator drifted too, say -- nothing can
  // be compared, and that is a failure to report rather than a crash or a silent pass.
  it('reports an event it cannot pair with an emitting instruction', () => {
    const orphan = structuredClone(tx);
    const release = orphan.transaction.message.instructions.find(
      (ix: { programId: string }) => ix.programId === ESCROW,
    );
    release.data = '1111111111111';
    const [released] = checkValues(escrowIdl, ESCROW, orphan);
    expect(released.error).toBe('no release instruction to pair it with');
    expect(released.results).toEqual({});
  });

  // The pre-v4 program emitted Released 32 bytes short of the v4 IDL. That is already a layout
  // failure; decoding it with the v4 layout would read past the payload, so values skip it.
  it('leaves an event whose length disagrees with the IDL to the layout check', () => {
    const short = structuredClone(tx);
    const lines: string[] = short.meta.logMessages;
    const at = lines.findIndex((l) => l.startsWith('Program data: '));
    const payload = Buffer.from(lines[at].slice('Program data: '.length), 'base64');
    lines[at] = `Program data: ${payload.subarray(0, payload.length - 32).toString('base64')}`;
    expect(checkValues(escrowIdl, ESCROW, short)).toEqual([]);
  });

  // deposit_hash is checked by deriving the deposit PDA the release was signed by, so the two
  // 32-byte hashes cannot trade places unnoticed.
  it('catches deposit_hash and quote_hash swapped at equal length', () => {
    const drifted = withPayload(tx, 0, (p) => swap(p, 8, 8 + 104, 32));
    const [released] = checkValues(escrowIdl, ESCROW, drifted);
    expect(released.mismatches.map((m: { field: string }) => m.field)).toEqual(['deposit_hash']);
  });
});

describe('checkValues: Released with the surplus sent to the treasury', () => {
  // Built by hand: release sends the surplus to the treasury when the depositor's token account
  // refuses plain credits, which no mainnet release has done.
  const hash = Buffer.alloc(32, 0x33);
  const accounts = Object.fromEntries(
    escrowIdl.instructions
      .find((i: { name: string }) => i.name === 'release')
      .accounts.map((a: { name: string }, i: number) => [a.name, key(i + 1)]),
  );
  accounts.deposit = findProgramAddress([Buffer.from('deposit'), hash], ESCROW);
  const release = (
    net: bigint,
    toTreasury: bigint[],
    emitted: { surplus: bigint; fee: bigint },
  ) => {
    const gross = net + toTreasury.reduce((n, a) => n + a, 0n);
    return syntheticTx({
      programId: ESCROW,
      data: discriminatorOf(escrowIdl.instructions, 'release'),
      accounts: Object.values(accounts),
      balancesBefore: { [accounts.escrow_ata]: gross },
      transfers: [
        { source: accounts.escrow_ata, destination: accounts.recipient_ata, amount: net },
        ...toTreasury.map((amount) => ({
          source: accounts.escrow_ata,
          destination: accounts.treasury_ata,
          amount,
        })),
      ],
      event: Buffer.concat([
        discriminatorOf(escrowIdl.events, 'Released'),
        hash,
        Buffer.from(bs58.decode(accounts.recipient)),
        u64(gross),
        u64(gross - emitted.surplus),
        u64(emitted.surplus),
        u64(emitted.fee),
        u64(net),
        Buffer.alloc(32, 0x44),
      ]),
    });
  };

  it('reads the second treasury transfer as the surplus', () => {
    const [released] = checkValues(
      escrowIdl,
      ESCROW,
      release(900n, [100n, 7n], { surplus: 7n, fee: 100n }),
    );
    expect(released.mismatches).toEqual([]);
  });

  it('catches fee and surplus swapped when both went to the treasury', () => {
    const [released] = checkValues(
      escrowIdl,
      ESCROW,
      release(900n, [100n, 7n], { surplus: 100n, fee: 7n }),
    );
    expect(released.mismatches.map((m: { field: string }) => m.field).sort()).toEqual(
      ['fee_amount', 'intended_amount', 'surplus_amount'].sort(),
    );
  });

  it('accepts a lone treasury transfer as a surplus on a release with no fee', () => {
    const [released] = checkValues(
      escrowIdl,
      ESCROW,
      release(900n, [7n], { surplus: 7n, fee: 0n }),
    );
    expect(released.mismatches).toEqual([]);
  });
});

describe('checkValues: Deposited and Reserved', () => {
  // One mainnet transaction that deposits and then reserves the same deposit.
  const { tx } = load('../testdata/mainnet-v4-deposit-reserve.json');
  const fieldsOf = (r: { results: object }) => Object.keys(r.results).sort();
  const mismatched = (r: { mismatches: { field: string }[] }) =>
    r.mismatches.map((m) => m.field).sort();

  // fee_amount moves no tokens at deposit or reserve, so the transaction has nothing to check it
  // against; it is left to the cross-event checks.
  it('agrees with the deposit and reserve args, accounts and transfer', () => {
    const [deposited, reserved] = checkValues(escrowIdl, ESCROW, tx);
    expect([deposited.name, reserved.name]).toEqual(['Deposited', 'Reserved']);
    expect([deposited.mismatches, reserved.mismatches]).toEqual([[], []]);
    expect(fieldsOf(deposited)).toEqual(
      [
        'amount',
        'deadline',
        'deposit_hash',
        'depositor',
        'issued_at',
        'nonce',
        'releaser',
        'reserver',
      ].sort(),
    );
    expect(fieldsOf(reserved)).toEqual([
      'deposit_hash',
      'quote_hash',
      'recipient',
      'source_amount',
    ]);
  });

  // Deposited offsets: deposit_hash 0, depositor 32, reserver 64, releaser 96, amount 128, fee 136,
  // nonce 144, issued_at 152, deadline 160. Reserved: deposit_hash 0, recipient 32, quote_hash 64,
  // source_amount 96, fee_amount 104.
  it('catches equal-length swaps in either event', () => {
    let drifted = withPayload(tx, 0, (p) => swap(p, 8 + 144, 8 + 152, 8));
    expect(mismatched(checkValues(escrowIdl, ESCROW, drifted)[0])).toEqual(['issued_at', 'nonce']);
    drifted = withPayload(tx, 0, (p) => swap(p, 8 + 64, 8 + 96, 32));
    expect(mismatched(checkValues(escrowIdl, ESCROW, drifted)[0])).toEqual([
      'releaser',
      'reserver',
    ]);
    drifted = withPayload(tx, 1, (p) => swap(p, 8, 8 + 64, 32));
    expect(mismatched(checkValues(escrowIdl, ESCROW, drifted)[1])).toEqual([
      'deposit_hash',
      'quote_hash',
    ]);
  });
});

describe('checkValues: StrictFulfilled', () => {
  const { tx } = load('../testdata/mainnet-v4-strict-fulfill.json');

  it('agrees with the strict_fulfill args, accounts and transfer', () => {
    const [fulfilled] = checkValues(proxyIdl, PROXY, tx);
    expect(fulfilled.name).toBe('StrictFulfilled');
    expect(fulfilled.mismatches).toEqual([]);
    expect(Object.keys(fulfilled.results).sort()).toEqual(
      ['amount', 'deadline', 'issued_at', 'nonce', 'quote_hash', 'to', 'token'].sort(),
    );
  });

  // Offsets: quote_hash 0, to 32, token 64, amount 96, nonce 104, issued_at 112, deadline 120.
  it('catches amount and nonce swapped at equal length', () => {
    const drifted = withPayload(tx, 0, (p) => swap(p, 8 + 96, 8 + 104, 8));
    const [fulfilled] = checkValues(proxyIdl, PROXY, drifted);
    expect(fulfilled.mismatches.map((m: { field: string }) => m.field).sort()).toEqual([
      'amount',
      'nonce',
    ]);
  });
});

describe('checkValues with the pre-v4 IDL', () => {
  // The pre-v4 escrow's Reserved has no quote_hash, source_amount or fee_amount, and its Released
  // no quote_hash: those fields have nothing to compare, and must be left unchecked, never pass as
  // undefined === undefined. A real pre-v4 deposit, reserve and release from mainnet.
  const preV4 = load('../idl-history/pre-v4/escrow.json');
  const PRE_V4_ESCROW = '44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs';
  const { tx: opened } = load('../testdata/mainnet-pre-v4-deposit-reserve.json');
  const { tx: released } = load('../testdata/mainnet-pre-v4-release.json');

  it('checks only the fields the event declares and has a value to compare with', () => {
    const results = crossCheck([
      ...checkValues(preV4, PRE_V4_ESCROW, opened),
      ...checkValues(preV4, PRE_V4_ESCROW, released),
    ]);
    expect(results.map((r) => r.name)).toEqual(['Deposited', 'Reserved', 'Released']);
    const [deposited, reserved, release] = results;
    // Pre-v4 reserve left the fee alone, so release paid the deposit-time fee as is.
    expect(deposited.results.fee_amount).toBe('ok');
    expect(Object.keys(reserved.results).sort()).toEqual(['deposit_hash', 'recipient']);
    expect(Object.keys(release.results)).not.toContain('quote_hash');
    expect(Object.keys(release.results)).toHaveLength(7);
    expect(results.flatMap((r) => r.mismatches)).toEqual([]);
  });

  // A scan window can start after the deposit and still hold its reserve and release.
  it('leaves the deposit fee alone when the Deposited fell outside the scan', () => {
    const [, reserved] = checkValues(preV4, PRE_V4_ESCROW, opened);
    const results = crossCheck([reserved, ...checkValues(preV4, PRE_V4_ESCROW, released)]);
    expect(results.flatMap((r) => r.mismatches)).toEqual([]);
  });
});

describe('crossCheck', () => {
  // The same mainnet deposit across two transactions: deposit + reserve, then release.
  const opened = load('../testdata/mainnet-v4-deposit-reserve.json').tx;
  const { tx: released } = load('../testdata/mainnet-v4-release.json');
  const scan = (first = opened) => [
    ...checkValues(escrowIdl, ESCROW, first),
    ...checkValues(escrowIdl, ESCROW, released),
  ];

  // Fields no token movement or arg shows are pinned through the deposit's other events: the fee
  // the treasury received on release is the one reserve emitted, which is the deposit-time fee
  // rescaled to the charge, and release emits the quote_hash reserve was given.
  it('pins fee_amount and quote_hash through the deposit lifecycle', () => {
    const [deposited, reserved, release] = crossCheck(scan());
    expect([
      deposited.results.fee_amount,
      reserved.results.fee_amount,
      release.results.quote_hash,
    ]).toEqual(['ok', 'ok', 'ok']);
    expect([deposited, reserved, release].flatMap((r) => r.mismatches)).toEqual([]);
  });

  // The report says, per event, which fields were compared by value and which only by length: a
  // field no instance could be checked on stays listed as unchecked.
  it('summarizes which fields were value-checked per event', () => {
    expect(summarize(crossCheck(scan()))).toEqual({
      failed: false,
      events: {
        Deposited: { count: 1, checked: 9, unchecked: [], mismatches: [], errors: [] },
        Reserved: { count: 1, checked: 5, unchecked: [], mismatches: [], errors: [] },
        Released: { count: 1, checked: 8, unchecked: [], mismatches: [], errors: [] },
      },
    });
    const releaseOnly = summarize(crossCheck(checkValues(escrowIdl, ESCROW, released)));
    expect(releaseOnly.events.Released.unchecked).toEqual(['quote_hash']);
  });

  // Reserved offsets: source_amount 96, fee_amount 104.
  it('catches a Reserved fee_amount that disagrees with the fee the treasury received', () => {
    const drifted = withPayload(opened, 1, (p) => swap(p, 8 + 96, 8 + 104, 8));
    const [, reserved] = crossCheck(scan(drifted));
    expect(reserved.mismatches.map((m: { field: string }) => m.field).sort()).toEqual([
      'fee_amount',
      'source_amount',
    ]);
  });

  // A mismatch is only actionable with the transaction it came from.
  it('fails the summary and names the transaction of each mismatch', () => {
    const drifted = withPayload(opened, 1, (p) => swap(p, 8 + 96, 8 + 104, 8));
    const signed = scan(drifted).map((c, i) => ({ ...c, signature: `sig${i}` }));
    const summary = summarize(crossCheck(signed));
    expect(summary.failed).toBe(true);
    expect(
      summary.events.Reserved.mismatches.map((m: { signature: string }) => m.signature),
    ).toEqual(['sig1', 'sig1']);
  });
});

describe('checkValues: Refunded', () => {
  // v4 mainnet has never refunded, so this is built by hand in the refund instruction's shape.
  const hash = Buffer.alloc(32, 0x11);
  const accounts = Object.fromEntries(
    escrowIdl.instructions
      .find((i: { name: string }) => i.name === 'refund')
      .accounts.map((a: { name: string }, i: number) => [a.name, key(i + 1)]),
  );
  accounts.deposit = findProgramAddress([Buffer.from('deposit'), hash], ESCROW);
  const refund = (amount: bigint, emitted: bigint) =>
    syntheticTx({
      programId: ESCROW,
      data: discriminatorOf(escrowIdl.instructions, 'refund'),
      accounts: Object.values(accounts),
      transfers: [{ source: accounts.escrow_ata, destination: accounts.depositor_ata, amount }],
      event: Buffer.concat([
        discriminatorOf(escrowIdl.events, 'Refunded'),
        hash,
        Buffer.from(bs58.decode(accounts.depositor)),
        u64(emitted),
        Buffer.alloc(32, 0x22),
      ]),
    });

  it('agrees with the refund accounts and the transfer back to the depositor', () => {
    const [refunded] = checkValues(escrowIdl, ESCROW, refund(500n, 500n));
    expect(refunded.mismatches).toEqual([]);
    expect(Object.keys(refunded.results).sort()).toEqual(['amount', 'deposit_hash', 'depositor']);
  });

  it('catches an amount the depositor did not receive', () => {
    const [refunded] = checkValues(escrowIdl, ESCROW, refund(500n, 499n));
    expect(refunded.mismatches.map((m: { field: string }) => m.field)).toEqual(['amount']);
  });
});

describe('checkValues: Fulfilled', () => {
  // v4 mainnet has never emitted the non-strict Fulfilled, so this is built by hand too.
  const accounts = Object.fromEntries(
    proxyIdl.instructions
      .find((i: { name: string }) => i.name === 'fulfill')
      .accounts.map((a: { name: string }, i: number) => [a.name, key(i + 1)]),
  );
  const quote = Buffer.alloc(32, 0x33);
  const fulfill = (emittedTo: string) =>
    syntheticTx({
      programId: PROXY,
      data: Buffer.concat([discriminatorOf(proxyIdl.instructions, 'fulfill'), quote, u64(700n)]),
      accounts: Object.values(accounts),
      transfers: [{ source: accounts.from_ata, destination: accounts.to_ata, amount: 700n }],
      event: Buffer.concat([
        discriminatorOf(proxyIdl.events, 'Fulfilled'),
        quote,
        Buffer.from(bs58.decode(emittedTo)),
        Buffer.from(bs58.decode(accounts.mint)),
        u64(700n),
      ]),
    });

  it('agrees with the fulfill args, accounts and transfer', () => {
    const [fulfilled] = checkValues(proxyIdl, PROXY, fulfill(accounts.to));
    expect(fulfilled.mismatches).toEqual([]);
    expect(Object.keys(fulfilled.results).sort()).toEqual(['amount', 'quote_hash', 'to', 'token']);
  });

  // to and token are both pubkeys, so one can carry the other's value at the same length.
  it('catches a recipient other than the to account', () => {
    const [fulfilled] = checkValues(proxyIdl, PROXY, fulfill(accounts.mint));
    expect(fulfilled.mismatches.map((m: { field: string }) => m.field)).toEqual(['to']);
  });
});

describe('checkValues: pre-v4 StrictFulfilled', () => {
  // Pre-v4 emitted payment_id (the strict_fulfill arg) and from (the settler) where v4 has
  // quote_hash. A real pre-v4 transaction, decoded with the pre-v4 IDL.
  const preV4 = load('../idl-history/pre-v4/fulfillment_proxy.json');
  const PRE_V4_PROXY = '77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe';
  const { tx } = load('../testdata/mainnet-pre-v4-strict-fulfill.json');

  it('checks payment_id and from too', () => {
    const [fulfilled] = checkValues(preV4, PRE_V4_PROXY, tx);
    expect(fulfilled.mismatches).toEqual([]);
    expect(Object.keys(fulfilled.results).sort()).toEqual(
      ['amount', 'deadline', 'from', 'issued_at', 'nonce', 'payment_id', 'to', 'token'].sort(),
    );
  });

  // Offsets: payment_id 0, to 32, from 64.
  it('catches to and from swapped at equal length', () => {
    const drifted = withPayload(tx, 0, (p) => swap(p, 8 + 32, 8 + 64, 32));
    const [fulfilled] = checkValues(preV4, PRE_V4_PROXY, drifted);
    expect(fulfilled.mismatches.map((m: { field: string }) => m.field).sort()).toEqual([
      'from',
      'to',
    ]);
  });
});
