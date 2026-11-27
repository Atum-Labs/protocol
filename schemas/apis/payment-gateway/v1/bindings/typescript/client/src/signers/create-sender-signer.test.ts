// createSenderSigner lowercases the CAIP-2 namespace before handing it to the Turnkey signer,
// whose impl switches on that prefix and refuses a namespace it does not recognize. The prefix is
// only observable at sign time, so the lazily loaded impl is stubbed to capture what it receives.
jest.mock('./turnkey-impl', () => ({
  turnkeySign: jest.fn(async () => ({ signature: '0xsignature' })),
  resolveSenderAddresses: jest.fn(),
}));

import { createSenderSigner } from './index';
import { turnkeySign } from './turnkey-impl';

const turnkeySignMock = turnkeySign as jest.MockedFunction<typeof turnkeySign>;

const cfg = {
  provider: 'turnkey' as const,
  organizationId: 'org',
  walletId: 'wallet',
  apiPublicKey: 'public',
  apiPrivateKey: 'private',
};

describe('createSenderSigner Turnkey chain prefix', () => {
  beforeEach(() => {
    turnkeySignMock.mockClear();
  });

  it.each([
    ['EIP155:42161', 'eip155'],
    ['SOLANA:mainnet', 'solana'],
    // A mixed-case namespace is the spelling a whole-string case check would let through.
    ['Eip155:42161', 'eip155'],
    ['tron:shasta', 'tron'],
  ])('%s reaches the Turnkey impl as %s', async (sourceChainId, expected) => {
    const signer = createSenderSigner(sourceChainId, cfg);

    await signer.sign({ message: '0xab', signature: '' });

    expect(turnkeySignMock.mock.calls[0]![0]).toBe(expected);
  });
});
