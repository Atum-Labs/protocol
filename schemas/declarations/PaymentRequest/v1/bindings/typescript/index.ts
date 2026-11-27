// Public entry for the PaymentRequest v1 TypeScript binding. Hand-written barrel that
// re-exports the machine-generated types from ./generated — kept in a separate folder so
// generated code stays clearly separated from editable code. Regenerating the bindings
// (make generate-ts-bindings) only rewrites ./generated/index.ts; this file is stable.
export * from './generated/index.js';
export * from './eip3009.js';
export * from './validate.js';
