import { requirePinnedSender } from './pinned-address';
import type { SignedMessage } from '../generated/types.gen';
import type { SenderSignature, SenderSigner, TurnkeyConfig } from './types';
import type { Logger, Meter } from '@atum-labs/turnkey-signer';

/** Typed contract for the lazily-loaded ./turnkey-impl module; also the test's conformance target. */
export interface TurnkeyImplModule {
  // Function-typed property (not a method) so params are checked contravariantly —
  // the conformance test then catches a parameter reorder.
  turnkeySign: (
    chainPrefix: string,
    cfg: {
      organizationId: string;
      walletId: string;
      apiPublicKey: string;
      apiPrivateKey: string;
      pinnedAddress?: string;
      logger?: Logger;
      meter?: Meter;
    },
    message: string,
    messagePrehash: string | undefined,
  ) => Promise<SenderSignature>;
}

// Lazy import: the Turnkey + @solana/web3.js code loads only when signing via
// Turnkey, never on the private-key path or a plain SDK import.
async function loadImpl(): Promise<TurnkeyImplModule> {
  return import('./turnkey-impl');
}

/** Turnkey-backed sender signer for a single source chain; the heavy impl is loaded lazily. */
export class TurnkeySenderSigner implements SenderSigner {
  /**
   * Validated at construction and read from here rather than from `cfg`, so a caller that
   * later blanks the config object it passed cannot erase the pin before it is forwarded.
   */
  private readonly pinnedAddress: string | undefined;

  constructor(
    private readonly chainPrefix: string,
    private readonly cfg: TurnkeyConfig,
    private readonly loader: () => Promise<TurnkeyImplModule> = loadImpl,
  ) {
    this.pinnedAddress = requirePinnedSender(cfg.pinnedAddress);
  }

  async sign(signedMessage: SignedMessage): Promise<SenderSignature> {
    const impl = await this.loader();
    return impl.turnkeySign(
      this.chainPrefix,
      {
        organizationId: this.cfg.organizationId,
        walletId: this.cfg.walletId,
        apiPublicKey: this.cfg.apiPublicKey,
        apiPrivateKey: this.cfg.apiPrivateKey,
        ...(this.pinnedAddress ? { pinnedAddress: this.pinnedAddress } : {}),
        ...(this.cfg.logger ? { logger: this.cfg.logger } : {}),
        ...(this.cfg.meter ? { meter: this.cfg.meter } : {}),
      },
      signedMessage.message,
      signedMessage.message_prehash,
    );
  }
}
