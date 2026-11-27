// Subpath shim for the classic Node resolution algorithm.
//
// package.json's "exports" map already declares "./signing", but `moduleResolution: "node"` —
// still the default for plenty of consumers — does not read "exports" at all. It resolves
// `@atum-labs/payment-gateway-client/signing` by looking for this file on disk. Without it the
// subpath works under "node16"/"bundler" and fails everywhere else, which is a failure a
// consumer meets at install rather than one we meet in CI.
//
// The publish guard caught exactly that: it type-checks against the packed tarball on the default
// settings, and the import did not resolve until this existed.
module.exports = require('./dist/signing.js');
