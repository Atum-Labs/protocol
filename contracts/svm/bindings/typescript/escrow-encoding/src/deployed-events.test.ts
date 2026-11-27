/**
 * Pure half of scripts/check-deployed-events.mjs: what the IDL says each event's payload is, and
 * how a transaction's log lines map to the program that emitted them. The RPC half is not unit
 * tested; it only feeds these.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  checkEvents,
  coverage,
  eventLayouts,
  programData,
} from '../scripts/lib/deployed-events.mjs';

const idl = {
  events: [{ name: 'Released', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }],
  types: [
    {
      name: 'Released',
      type: {
        kind: 'struct',
        fields: [
          { name: 'settler', type: 'pubkey' },
          { name: 'amount', type: 'u64' },
          { name: 'quote_hash', type: { array: ['u8', 32] } },
        ],
      },
    },
  ],
};

describe('eventLayouts', () => {
  it('keys each event by discriminator with its fixed payload size', () => {
    expect(eventLayouts(idl).get('0102030405060708')).toEqual({ name: 'Released', size: 72 });
  });

  // A length check is only meaningful for a fixed-size payload. Refuse rather than return NaN, which
  // would compare unequal to every observed length and read as drift.
  it.each([['string'], [{ vec: 'u8' }], [{ option: 'u64' }]])(
    'refuses an event with a variable-size field (%j)',
    (type) => {
      const variable = structuredClone(idl);
      variable.types[0].type.fields.push({ name: 'memo', type });
      expect(() => eventLayouts(variable)).toThrow(/Released\.memo/);
    },
  );
});

describe('programData', () => {
  // A FulfillmentProxy transaction CPIs into the escrow, so both programs' events share one log.
  // Each line belongs to the innermost program executing when it was written.
  it('attributes each Program data line to the program executing it', () => {
    const logs = [
      'Program Proxy111 invoke [1]',
      'Program data: AQI=',
      'Program Escrow11 invoke [2]',
      'Program log: Instruction: Release',
      'Program data: AwQ=',
      'Program Escrow11 consumed 1000 of 2000 compute units',
      'Program Escrow11 success',
      'Program data: BQY=',
      'Program Proxy111 success',
    ];
    expect(programData(logs)).toEqual([
      { program: 'Proxy111', data: Buffer.from([1, 2]) },
      { program: 'Escrow11', data: Buffer.from([3, 4]) },
      { program: 'Proxy111', data: Buffer.from([5, 6]) },
    ]);
  });
});

describe('checkEvents', () => {
  const layouts = eventLayouts(idl);
  const event = (discriminator: number[], payloadBytes: number) =>
    Buffer.concat([Buffer.from(discriminator), Buffer.alloc(payloadBytes)]);

  it('counts payloads whose length matches the IDL', () => {
    const r = checkEvents(layouts, [event([1, 2, 3, 4, 5, 6, 7, 8], 72)]);
    expect(r).toEqual({ matched: { Released: 1 }, mismatched: [], unknown: [] });
  });

  // The pre-v4 Solana escrow emitted Released without the trailing 32-byte quote_hash: the
  // discriminator still matches, only the length gives it away.
  it('reports a known event whose payload length differs from the IDL', () => {
    const r = checkEvents(layouts, [event([1, 2, 3, 4, 5, 6, 7, 8], 40)]);
    expect(r.mismatched).toEqual([{ name: 'Released', idl: 72, chain: 40, count: 1 }]);
  });

  it('reports a discriminator the IDL does not declare', () => {
    const r = checkEvents(layouts, [event([9, 9, 9, 9, 9, 9, 9, 9], 16)]);
    expect(r.unknown).toEqual([{ discriminator: '0909090909090909', chain: 16, count: 1 }]);
  });
});

describe('coverage', () => {
  const twoEvents = structuredClone(idl);
  twoEvents.events.push({ name: 'Refunded', discriminator: [8, 7, 6, 5, 4, 3, 2, 1] });
  twoEvents.types.push({
    name: 'Refunded',
    type: { kind: 'struct', fields: [{ name: 'amount', type: 'u64' }] },
  });
  const layouts = eventLayouts(twoEvents);
  const released = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.alloc(72)]);

  // A pass that only lists what it saw says nothing about the events it never saw. Every declared
  // event gets a row, so an event the window did not contain reads as unverified, not as fine.
  it('lists a declared event that was never observed as UNVERIFIED', () => {
    expect(coverage(layouts, checkEvents(layouts, [released]), []).rows).toEqual([
      { name: 'Released', status: 'OK', count: 1 },
      { name: 'Refunded', status: 'UNVERIFIED', count: 0 },
    ]);
  });

  // Rare admin events cannot be required (most windows hold none), but the events accounting reads
  // can: an unobserved one fails, so a green run means its layout was actually compared.
  it('fails only when a required event is UNVERIFIED', () => {
    const checked = checkEvents(layouts, [released]);
    expect(coverage(layouts, checked, []).failed).toBe(false);
    expect(coverage(layouts, checked, ['Released']).failed).toBe(false);
    expect(coverage(layouts, checked, ['Refunded']).failed).toBe(true);
  });

  // Drift outranks coverage: an event seen with the wrong length is a MISMATCH even when other
  // payloads of it matched, and drift fails the run whether or not the event is required.
  it('marks a drifted event MISMATCH and fails on any drift', () => {
    const short = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.alloc(40)]);
    const r = coverage(layouts, checkEvents(layouts, [released, short]), []);
    expect(r.rows[0]).toEqual({ name: 'Released', status: 'MISMATCH', count: 2 });
    expect(r.failed).toBe(true);
    const stranger = Buffer.concat([Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]), Buffer.alloc(16)]);
    expect(coverage(layouts, checkEvents(layouts, [released, stranger]), []).failed).toBe(true);
  });

  // A misspelt required event has no row, so it could never be UNVERIFIED and would never fail.
  it('refuses a required event the IDL does not declare', () => {
    expect(() => coverage(layouts, checkEvents(layouts, []), ['Releasd'])).toThrow(/Releasd/);
  });
});

// The payload lengths each served program generation was observed emitting on mainnet. Pins the
// committed IDLs to them: a pre-v4 snapshot "refreshed" from a current build, or a v4 IDL synced
// from a build that was never deployed, fails here. Also proves every committed event stays
// fixed-size, which the deployed-events check depends on.
describe('committed IDLs match the layouts observed on mainnet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sizes = (path: string) =>
    Object.fromEntries(
      [...eventLayouts(JSON.parse(readFileSync(resolve(here, path), 'utf8'))).values()].map((l) => [
        l.name,
        l.size,
      ]),
    );

  it.each([
    ['v4', './generated/escrow.json', { Deposited: 168, Released: 136, Reserved: 112 }],
    ['v4', './generated/fulfillment_proxy.json', { StrictFulfilled: 128 }],
    [
      'pre-v4',
      '../idl-history/pre-v4/escrow.json',
      { Deposited: 168, Released: 104, Reserved: 64 },
    ],
    ['pre-v4', '../idl-history/pre-v4/fulfillment_proxy.json', { StrictFulfilled: 160 }],
  ])('%s %s', (_generation, path, observed) => {
    expect(sizes(path)).toMatchObject(observed);
  });
});
