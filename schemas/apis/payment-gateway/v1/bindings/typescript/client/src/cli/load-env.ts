import { config } from 'dotenv';

/**
 * Load an optional `.env` file from the current working directory into
 * `process.env`, for the CLIs.
 *
 * Deliberately not called from the SDK entry point. The SDK and the CLIs ship in
 * the same package, but loading an env file is a side effect on the host process:
 * a library doing it would read whatever `.env` happens to sit in the working
 * directory of the consuming service and could overwrite configuration that
 * application set deliberately. Populating the environment belongs to the
 * entry point; the SDK only reads it (see the `GATEWAY_URL` resolution in
 * {@link PaymentGatewayClient}). An SDK consumer that keeps `GATEWAY_URL` in a
 * file loads it in their own application.
 *
 * `override: false` (dotenv's default) is load-bearing: a variable already
 * present in the environment wins over the file, which preserves the documented
 * precedence — a CLI flag, then the environment, then `.env`, then the built-in
 * default.
 *
 * A missing `.env` is a no-op: the file is optional and most invocations pass
 * flags instead.
 */
export function loadCliEnv(): void {
  config({ override: false, quiet: true });
}
