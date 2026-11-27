import * as published from './index';
import type { AwardQuoteResponse, AwardRequest, PaymentResponse } from './index';

const reserveAuth = { message: '0x01', message_prehash: '{}', signature: '0x02' };

describe('award request', () => {
  it('requires only the award key, the quote request and the chosen quote', () => {
    expect([...published.$AwardRequest.required]).toEqual([
      'request_id',
      'quote_request_id',
      'quote_id',
    ]);
    expect(Object.keys(published.$AwardRequest.properties)).toEqual(
      expect.arrayContaining(['sender_auth', 'reserve_auth', 'originator_auth']),
    );
  });

  it('publishes no client-built award and no award-only response body', () => {
    for (const removed of ['$BidAward', '$AwardResponse', '$AwardAccepted']) {
      expect(published).not.toHaveProperty(removed);
    }
    expect(published).toHaveProperty('$ReserveAuth');
  });

  it('requires the signed reserve record on every chain', () => {
    expect([...published.$ReserveAuth.required].sort()).toEqual([
      'message',
      'message_prehash',
      'signature',
    ]);
  });

  it('types the award as the client-signed request answered by a PaymentResponse', () => {
    const award: AwardRequest = {
      request_id: 'award-1',
      quote_request_id: 'qr_1',
      quote_id: '0x9a3b',
      reserve_auth: reserveAuth,
    };
    const withBidAward: AwardRequest = {
      request_id: 'award-1',
      quote_request_id: 'qr_1',
      quote_id: '0x9a3b',
      // @ts-expect-error the client no longer builds a BidAward
      bid_award: {},
    };
    const withoutPrehash: AwardRequest = {
      request_id: 'award-1',
      quote_request_id: 'qr_1',
      quote_id: '0x9a3b',
      // @ts-expect-error the settler builds the reserve from message_prehash
      reserve_auth: { message: '0x01', signature: '0x02' },
    };
    const withPayload: AwardRequest = {
      request_id: 'award-1',
      quote_request_id: 'qr_1',
      quote_id: '0x9a3b',
      // @ts-expect-error a reserve message carries no chain-specific payload
      reserve_auth: { ...reserveAuth, payload: {} },
    };
    const answer: PaymentResponse = {
      payment_id: '0x1',
      status: 'pending',
      idempotent_replay: false,
    };
    const awarded: AwardQuoteResponse = answer;
    const asPayment: PaymentResponse = awarded;

    expect([award, withBidAward, withoutPrehash, withPayload, asPayment]).toHaveLength(5);
  });
});
