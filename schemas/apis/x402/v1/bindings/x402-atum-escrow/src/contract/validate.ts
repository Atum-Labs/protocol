/**
 * Runtime validators for the atum-escrow wire types, compiled from the published
 * JSON Schemas — the single source of truth. Roles call these at inbound trust
 * boundaries (the client reading a 402, the facilitator reading a payload) so a
 * malformed value fails with a schema error rather than deep in signing or
 * settlement. Deriving the runtime check from the same `schema.json` that
 * generates the TypeScript types is what keeps the two from drifting.
 */
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { AtumEscrowExtra, AtumEscrowPayload } from '@atum-labs/atum-escrow';
// Import the schemas statically so the bundler inlines them into the output. A
// runtime readFileSync would not survive bundling: the path resolves relative to
// the emitted file, and the schema files live outside a published package's files[].
// The raw JSON is not re-exported by the bindings package, so it is read from
// schemas/ (the single source of truth) by relative path.
import extraSchema from '../../../../extra/schema.json';
import payloadSchema from '../../../../payload/schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Compiled lazily on first use, so importing this module does no work up front.
let extraValidator: ValidateFunction | undefined;
let payloadValidator: ValidateFunction | undefined;

/**
 * Assert that `value` conforms to the published `AtumEscrowExtra` schema.
 *
 * @param value - the candidate `extra.atum` block (typically from an inbound 402)
 * @throws if `value` does not conform, with the schema errors in the message
 * @public
 */
export function assertAtumEscrowExtra(value: unknown): asserts value is AtumEscrowExtra {
  extraValidator ??= ajv.compile(extraSchema as object);
  if (!extraValidator(value)) {
    throw new Error(`invalid extra.atum: ${ajv.errorsText(extraValidator.errors)}`);
  }
}

/**
 * Assert that `value` conforms to the published `AtumEscrowPayload` schema.
 *
 * @param value - the candidate `PAYMENT-SIGNATURE` payload (the facilitator's inbound boundary)
 * @throws if `value` does not conform, with the schema errors in the message
 * @public
 */
export function assertAtumEscrowPayload(value: unknown): asserts value is AtumEscrowPayload {
  payloadValidator ??= ajv.compile(payloadSchema as object);
  if (!payloadValidator(value)) {
    throw new Error(`invalid atum-escrow payload: ${ajv.errorsText(payloadValidator.errors)}`);
  }
}
