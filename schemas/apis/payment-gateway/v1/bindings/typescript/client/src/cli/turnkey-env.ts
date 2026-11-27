import type { TurnkeyConfig } from '../signers';

/**
 * Turnkey credentials for `--provider turnkey`, from the environment only: secrets never travel as
 * command-line flags, where they would land in shell history and process listings.
 */
export function loadTurnkeyConfigFromEnv(): TurnkeyConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`--provider turnkey requires the ${name} environment variable`);
    }
    return value;
  };
  return {
    organizationId: required('TURNKEY_ORGANIZATION_ID'),
    walletId: required('TURNKEY_WALLET_ID'),
    apiPublicKey: required('TURNKEY_API_PUBLIC_KEY'),
    apiPrivateKey: required('TURNKEY_API_PRIVATE_KEY'),
  };
}
