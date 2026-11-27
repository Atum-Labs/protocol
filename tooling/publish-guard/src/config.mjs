// Per-package configuration for the shared publish guard.
//
// Everything the two publishable packages genuinely differ on lives here; the
// invariants themselves are shared (see check.mjs). Adding a new publishable
// package should mean writing a config file, not copying a script.
//
// Config file: `<pkgRoot>/publish-guard.config.mjs`, default-exporting:
//
//   {
//     displayName:      string   published name for the notices header
//     externalDepsNote: string   verbatim fragment naming deps the notices do NOT cover
//     requiredFiles?:   string[] files that must be in the tarball
//     consumer: {
//       moduleFormat:    'cjs' | 'esm'
//       typeCheckLabel:  string             shown in the guard's success/failure line
//       imports:         { [subpath]: string[] }  symbols to import per entrypoint
//       subpaths?:       string[]           entrypoints to load at runtime (default ['.'])
//       extraInstalls?:  string[]           extra npm specs the shipped .d.ts needs
//       tsconfig?:       object             compilerOptions; omit for tsc CLI defaults
//     }
//   }
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const CONFIG_FILENAME = 'publish-guard.config.mjs';

export async function loadConfig(pkgRoot) {
  const p = join(pkgRoot, CONFIG_FILENAME);
  if (!existsSync(p)) {
    throw new Error(
      `${CONFIG_FILENAME} not found in ${pkgRoot}. Every package using publish-guard must declare one ` +
        `(see tooling/publish-guard/README.md).`,
    );
  }
  const mod = await import(pathToFileURL(p).href);
  const cfg = mod.default;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`${p} must default-export a config object.`);
  }
  for (const required of ['displayName', 'externalDepsNote', 'consumer']) {
    if (cfg[required] === undefined)
      throw new Error(`${p} is missing required field "${required}".`);
  }
  if (!cfg.consumer.imports || Object.keys(cfg.consumer.imports).length === 0) {
    throw new Error(`${p}: consumer.imports must name at least one exported symbol to type-check.`);
  }
  return cfg;
}
