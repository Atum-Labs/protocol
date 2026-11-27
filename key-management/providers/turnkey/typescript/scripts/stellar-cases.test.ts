import { describe, expect, it } from 'vitest';

import type { TurnkeyClient } from '../src/client';
import { stellarCases } from './stellar-cases';

const G = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    signRawPayload: async (input: Record<string, unknown>) => {
      sent.push(input);
      return {};
    },
  } as unknown as TurnkeyClient;
  return { sent, client: () => client };
}

describe('stellarCases', () => {
  it('leads with the positive control, so the deny rows cannot pass vacuously', () => {
    const { client } = recorder();
    const cases = stellarCases({ role: 'settler', stellarAddress: G, client });
    expect(cases[0]?.expect).toBe('ALLOW');
    expect(cases[0]?.name).toMatch(/positive control/);
  });

  it('signs every row with the Stellar account and sends the documented ed25519 pairing', async () => {
    const r = recorder();
    for (const c of stellarCases({ role: 'settler', stellarAddress: G, client: r.client })) await c.run();
    expect(r.sent.every((s) => s.signWith === G)).toBe(true);
    expect(r.sent[0]).toMatchObject({
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });
    expect(r.sent.map((s) => s.hashFunction)).toEqual([
      'HASH_FUNCTION_NOT_APPLICABLE',
      'HASH_FUNCTION_NOT_APPLICABLE',
      'HASH_FUNCTION_SHA256',
      'HASH_FUNCTION_NO_OP',
    ]);
  });

  it('expects the text handshake allowed for a settler and a sender, denied for the verifier', () => {
    const text = (role: 'settler' | 'sender' | 'verifier') =>
      stellarCases({ role, stellarAddress: G, client: recorder().client }).find((c) => c.name.includes('TEXT_UTF8'))!
        .expect;
    expect(text('settler')).toBe('ALLOW');
    expect(text('sender')).toBe('ALLOW');
    expect(text('verifier')).toBe('DENY');
  });

  it('does not build the client until a case runs', () => {
    let built = false;
    const cases = stellarCases({
      role: 'settler',
      stellarAddress: G,
      client: () => {
        built = true;
        return {} as TurnkeyClient;
      },
    });
    expect(cases.length).toBeGreaterThan(0);
    expect(built).toBe(false);
  });
});
