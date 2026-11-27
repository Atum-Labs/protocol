// Thin shim over the shared stamper (@atum-labs/publish-guard). Entry files are
// derived from this package's manifest (`main` + `bin`), so a newly added CLI is
// covered automatically. `check:publishable` then asserts the notice is present on
// every entry file and absent from every dependency chunk.
//
// Runs after the bundler (see the `build` script).
import { fileURLToPath, URL } from 'node:url';
import { stampEntryHeaders } from '@atum-labs/publish-guard';

stampEntryHeaders({ pkgRoot: fileURLToPath(new URL('..', import.meta.url)) });
