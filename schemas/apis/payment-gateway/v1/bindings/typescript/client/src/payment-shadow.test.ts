import { readDepositRequest } from '@atum-labs/payment-request-sender-auth';
import { PaymentGatewayClient, sdkPaymentShadow, submitPaymentShadow } from './index';
import type { PaymentRequest, SubmitPaymentData } from './index';
import type { ApiRequestOptions } from './generated/core/ApiRequestOptions';
import { BaseHttpRequest } from './generated/core/BaseHttpRequest';
import { CancelablePromise } from './generated/core/CancelablePromise';
import vectors from '../../../../../../../declarations/PaymentRequest/v1/conformance/commitment-v2-vectors.json';

const signed = (vectors as { requests: Array<{ name: string; request: string }> }).requests.find(
  (r) => r.name === 'strict-evm-v1/audit',
)!.request;

describe('submitPaymentShadow', () => {
  it('sends nothing without a shadow', () => {
    expect(submitPaymentShadow(undefined)).toEqual({});
  });

  it('maps a shadow onto the two header parameters', () => {
    expect(submitPaymentShadow({ producer: 'mppx', depositRequestHashV2: '0xab' })).toEqual({
      xAtumProducer: 'mppx',
      xAtumDepositRequestHashV2: '0xab',
    });
  });

  it('sends only the producer when the shadow has no v2', () => {
    expect(submitPaymentShadow({ producer: 'x402' })).toEqual({ xAtumProducer: 'x402' });
  });
});

describe('sdkPaymentShadow', () => {
  it('names the SDK and the v2 the gateway reads from the body as posted', () => {
    const pr = JSON.parse(signed) as PaymentRequest;
    expect(sdkPaymentShadow(pr)).toEqual({
      producer: 'sdk-ts',
      depositRequestHashV2: readDepositRequest(JSON.stringify(pr)).depositRequestHashV2,
    });
  });
});

describe('PaymentGatewayClient payments.submitPayment', () => {
  const sent: ApiRequestOptions[] = [];
  class RecordingRequest extends BaseHttpRequest {
    request<T>(options: ApiRequestOptions): CancelablePromise<T> {
      sent.push(options);
      return new CancelablePromise<T>((resolve) =>
        resolve({ payment_id: '0xpay', status: 'pending' } as T),
      );
    }
  }
  const submitted = async (data: SubmitPaymentData) => {
    sent.length = 0;
    await new PaymentGatewayClient(
      { BASE: 'https://gateway.invalid' },
      RecordingRequest,
    ).payments.submitPayment(data);
    expect(sent).toHaveLength(1);
    return sent[0]!.headers;
  };
  const pr = JSON.parse(signed) as PaymentRequest;

  it('sends the SDK shadow with a plain submit', async () => {
    expect(await submitted({ requestBody: pr })).toEqual({
      'X-Atum-Producer': 'sdk-ts',
      'X-Atum-Deposit-Request-Hash-V2': readDepositRequest(JSON.stringify(pr)).depositRequestHashV2,
    });
  });

  it('sends only the producer for a body the strict reader refuses', async () => {
    const refused = { ...pr, unknown_member: 1 } as PaymentRequest;
    expect(await submitted({ requestBody: refused })).toEqual({
      'X-Atum-Producer': 'sdk-ts',
      'X-Atum-Deposit-Request-Hash-V2': undefined,
    });
  });

  it('sends a shadow the caller names as given', async () => {
    const named = submitPaymentShadow({ producer: 'mppx', depositRequestHashV2: '0xab' });
    expect(await submitted({ requestBody: pr, ...named })).toEqual({
      'X-Atum-Producer': 'mppx',
      'X-Atum-Deposit-Request-Hash-V2': '0xab',
    });
  });
});
