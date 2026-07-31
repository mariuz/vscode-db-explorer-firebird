/**
 * Shared connection options for the e2e tier.
 *
 * Every e2e suite previously built this itself and hard-coded `wireCrypt: WIRE_CRYPT_DISABLE`,
 * which meant the whole tier could only ever run against a server with wire encryption switched
 * off — including the four identical copies drifting independently. Wire encryption is now driven
 * by `FIREBIRD_WIRE_CRYPT`, the same variable `scripts/seed-test-db.js` and the vscode-host tier's
 * `src/test/suite/firebird-test-env.ts` already read, so one setting configures all three.
 *
 * The default stays `Disabled`, matching what `.github/workflows/e2e.yml` configures its Firebird
 * containers with (`FIREBIRD_CONF_WireCrypt: Disabled`) — so nothing about the existing matrix
 * changes. Set `FIREBIRD_WIRE_CRYPT=Enabled` to run against a server that requires encryption,
 * which is the default for a stock Firebird 4+ install.
 *
 * NOTE: this file intentionally does not end in `.test.ts`, so Mocha's `out/test/e2e/**\/*.test.js`
 * glob doesn't try to run it as a suite — the same convention (and for the same reason) as
 * `src/test/suite/firebird-test-env.ts`.
 */

import * as Firebird from 'node-firebird';

/**
 * node-firebird exposes only `WIRE_CRYPT_DISABLE`/`WIRE_CRYPT_ENABLE` — there is no separate
 * "required" wire value — so anything other than an explicit `Disabled` maps to enabled, exactly
 * as `buildNodeFirebirdOptions()` in `src/shared/driver.ts` maps the extension's own
 * `'Required' | 'Enabled' | 'Disabled'` setting.
 */
export function wireCryptFromEnv(value = process.env.FIREBIRD_WIRE_CRYPT): number {
  return value && value.toLowerCase() !== 'disabled'
    ? Firebird.WIRE_CRYPT_ENABLE
    : Firebird.WIRE_CRYPT_DISABLE;
}

export function getE2EOptions(): Firebird.Options {
  return {
    host: process.env.FIREBIRD_HOST ?? 'localhost',
    port: Number(process.env.FIREBIRD_PORT ?? '3050'),
    database: process.env.FIREBIRD_DATABASE ?? '/var/lib/firebird/data/test.fdb',
    user: process.env.FIREBIRD_USER ?? 'sysdba',
    password: process.env.FIREBIRD_PASSWORD ?? 'masterkey',
    wireCrypt: wireCryptFromEnv(),
  };
}
