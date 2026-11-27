/**
 * Package version, defined in a single place so the CLIs report the true
 * published version instead of a hardcoded literal.
 *
 * The value is injected at build time from `package.json` by tsup via
 * `define` (see `tsup.config.ts`), so it is independent of where the built
 * file ends up in `dist/` — the four CLI bundles live one directory deeper
 * than `dist/index.js`, which would make a `__dirname`-relative lookup
 * fragile. When the constant is not injected (for example under ts-jest,
 * which does not run tsup), we fall back to a development sentinel.
 */
declare const __PGC_VERSION__: string | undefined;

export const PACKAGE_VERSION: string =
  typeof __PGC_VERSION__ !== 'undefined' ? __PGC_VERSION__ : '0.0.0-dev';
