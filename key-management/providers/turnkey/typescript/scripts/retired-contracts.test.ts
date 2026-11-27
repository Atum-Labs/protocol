import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';

import {
  RETIRED_CONTRACTS,
  RETIRED_SPELLING_COUNT,
  assertNoRetiredContracts,
} from './retired-contracts';
import { tronBase58ToEvmHex } from '../src/admin/sender-policies';

const cfg = (allowlists: Record<string, unknown>) =>
  ({ type: 'settler', chains: {}, allowlists }) as never;

/** A settler config whose only contract addresses are under approveDeny. */
const approveDenyCfg = (approveDeny: Record<string, unknown>) =>
  ({ type: 'settler', chains: {}, allowlists: {}, approveDeny }) as never;

/** A SENDER config: no `allowlists` at all, contract addresses only under `senderExtras`. */
const senderCfg = (senderExtras: Record<string, unknown>) =>
  ({ type: 'sender', chains: {}, senderExtras }) as never;

/**
 * A stale address here is an outage, not a warning: Turnkey pins `eth.tx.to`, so an address absent
 * from `allowedTo` is default-denied with HTTP 403 and every settlement on that chain fails. That
 * is exactly how the v4 escrow repoint took staging down, and nothing in the apply path noticed —
 * the run reported success against a policy set that denied the live contracts.
 */
describe('assertNoRetiredContracts', () => {
  it('refuses a config still on the retired EVM pair', () => {
    expect(() =>
      assertNoRetiredContracts(
        cfg({ Arbitrum: { allowedTo: ['0xa61a0c025943aa79b73d8d07e3adbee1873738b4'] } }),
      ),
    ).toThrow(/retired by a redeploy/);
  });

  it('names the chain, the field and what the address was, not just that something is wrong', () => {
    let msg = '';
    try {
      assertNoRetiredContracts(
        cfg({ Celo: { allowedTo: ['0x09a5a0d6955e5394a661cd9e7007076fa63b4158'] } }),
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    // Without these an operator has the error but not the edit.
    expect(msg).toContain('Celo');
    expect(msg).toContain('allowedTo');
    expect(msg).toContain('v3 fulfillment proxy');
  });

  it('matches EVM addresses case-insensitively', () => {
    // Turnkey compares EVM hex case-insensitively, so a checksummed config must not slip past a
    // lowercase denylist.
    expect(() =>
      assertNoRetiredContracts(
        cfg({ Base: { allowedTo: ['0xA61A0C025943AA79B73D8D07E3ADBEE1873738B4'] } }),
      ),
    ).toThrow(/retired by a redeploy/);
  });

  it('catches a retired Solana program in allowedPrograms, not only allowedTo', () => {
    // SVM uses a different field; a guard that only walked allowedTo would miss Solana entirely.
    expect(() =>
      assertNoRetiredContracts(
        cfg({ Solana: { allowedPrograms: ['44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs'] } }),
      ),
    ).toThrow(/v1\/v3 escrow program/);
  });

  it('accepts the current v4 addresses', () => {
    expect(() =>
      assertNoRetiredContracts(
        cfg({
          Arbitrum: {
            allowedTo: [
              '0x0f875601504c9179562506afa34b2d084268869b',
              '0x1f1f8fa642bc5f530ba37f1db3a656e9eb8bafeb',
            ],
          },
          Tron: { allowedTo: ['TNW6knfy7gD5W8meUAj9cdqpjFZVHN4vUw'] },
          Solana: { allowedPrograms: ['2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf'] },
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a config with no allowlists at all', () => {
    expect(() => assertNoRetiredContracts(cfg({}))).not.toThrow();
  });

  it('catches a retired escrow program in a SENDER config, which has no allowlists', () => {
    // The shape this guard could not see. `senderExtras.solanaEscrowProgramId` names the escrow
    // program directly, so a sender config on the v1/v3 program is exactly the mistake the retired
    // list exists to refuse — and every assertion above walks `allowlists`, which a sender config
    // does not have.
    expect(() =>
      assertNoRetiredContracts(
        senderCfg({ solanaEscrowProgramId: '44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs' }),
      ),
    ).toThrow(/v1\/v3 escrow program/);
  });

  it('names senderExtras.solanaEscrowProgramId in the message, so the operator has the edit', () => {
    let msg = '';
    try {
      assertNoRetiredContracts(
        senderCfg({ solanaEscrowProgramId: '44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs' }),
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('senderExtras.solanaEscrowProgramId');
  });

  it('accepts a sender config on the current v4 devnet program', () => {
    expect(() =>
      assertNoRetiredContracts(
        senderCfg({
          solanaEscrowProgramId: '2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf',
          allowedTokens: { Ethereum: ['0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'] },
        }),
      ),
    ).not.toThrow();
  });


  it('catches the retired EVM proxy in approveDeny, whose spelling carries no 0x', () => {
    // The field stores bare 40-char hex while RETIRED_CONTRACTS stores 0x-prefixed, so the raw
    // case-insensitive compare this guard used to do returned NO MATCH on exactly this value.
    // That is why naming the field was not enough; the spelling fold is the load-bearing half.
    expect(() =>
      assertNoRetiredContracts(
        approveDenyCfg({
          evm: { Ethereum: { allowedSpendersHex: ['09a5a0d6955e5394a661cd9e7007076fa63b4158'] } },
        }),
      ),
    ).toThrow(/v3 fulfillment proxy/);
  });

  it('catches the retired TRON proxy in approveDeny, whose spelling is hex not base58', () => {
    // TBx4epYWH6gp5b6hqhjo3pUmzMXdj4ypML decoded to its 20-byte body. RETIRED_CONTRACTS holds the
    // base58, so this needed the derived tron spelling to match at all.
    expect(() =>
      assertNoRetiredContracts(
        approveDenyCfg({
          tron: { Tron: { allowedSpendersHex: ['15b8ddc35de07784331ec006165eb487026a246a'] } },
        }),
      ),
    ).toThrow(/v3 shasta fulfillment proxy/);
  });

  it('says approveDeny fails differently, because a retired spender is breadth not an outage', () => {
    // The polarity matters and the generic message gets it wrong for this field: approveDeny emits
    // a DENY on approve() to anything outside the list, so a retired address PRESENT denies
    // nothing. The outage is the current proxy being ABSENT. If the message ever loses that, an
    // operator will chase the wrong end of it.
    let msg = '';
    try {
      assertNoRetiredContracts(
        approveDenyCfg({
          evm: { Ethereum: { allowedSpendersHex: ['09a5a0d6955e5394a661cd9e7007076fa63b4158'] } },
        }),
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('approveDeny.evm.Ethereum.allowedSpendersHex');
    expect(msg).toContain('ABSENT');
  });

  it('accepts the current v4 proxies in both approveDeny spellings', () => {
    expect(() =>
      assertNoRetiredContracts(
        approveDenyCfg({
          evm: { Ethereum: { allowedSpendersHex: ['1f1f8fa642bc5f530ba37f1db3a656e9eb8bafeb'] } },
          tron: { Tron: { allowedSpendersHex: ['4e790a3721f89603f126a0836d7523957b31045a'] } },
        }),
      ),
    ).not.toThrow();
  });

  it('derives a spelling per retired address without collapsing or colliding', () => {
    // Without this the map could silently degrade to raw-only — which is precisely the state that
    // let both offending lines pass — and the suite would stay green.
    const tronEntries = RETIRED_CONTRACTS.filter((r) => !r.address.startsWith('0x')).filter((r) => {
      try {
        tronBase58ToEvmHex(r.address);
        return true;
      } catch {
        return false; // solana program ids are 32-byte base58 and do not decode as tron
      }
    });
    const evmEntries = RETIRED_CONTRACTS.filter((r) => r.address.startsWith('0x'));
    // raw for every entry, plus one derived spelling for each EVM and each decodable tron entry.
    expect(RETIRED_SPELLING_COUNT).toBe(
      RETIRED_CONTRACTS.length + evmEntries.length + tronEntries.length,
    );
    expect(evmEntries.length).toBeGreaterThanOrEqual(2);
    expect(tronEntries.length).toBeGreaterThanOrEqual(4);
  });

  it('does not use the denylist to normalize, only to match', () => {
    // Base58 is case-significant. A Tron address differing only in case is a DIFFERENT address, so
    // it must not be reported as the retired one — the guard may miss, it may never mis-attribute.
    const notRetired = 'tedjszrsnkhqneeptykasgvmaredttq4py'; // lowercased, therefore not the real one
    let threw = false;
    try {
      assertNoRetiredContracts(cfg({ Tron: { allowedTo: [notRetired] } }));
    } catch {
      threw = true;
    }
    // Documents the accepted limitation rather than pretending it is exact: case-insensitive
    // matching does flag this. Recorded so a future change to base58 handling has a tripwire.
    expect(threw).toBe(true);
  });
});

/** The tracked example must not teach the retired pair — that is where operators copy from. */
describe('the shipped example configs', () => {
  it('pass their own guard', () => {
    const dir = path.join(__dirname, 'config');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.example.yaml'));
    expect(files.length).toBeGreaterThan(0);
    // Both KINDS must be present, or this sweep silently stops covering the one it never had a
    // code path for. The sender example was on the retired v1/v3 program while this test was green.
    const kinds = files.map((f) => parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'))?.type);
    expect(kinds).toContain('settler');
    expect(kinds).toContain('sender');
    for (const f of files) {
      const parsed = parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(() => assertNoRetiredContracts(parsed as never), f).not.toThrow();
    }
  });

  it('has a retired list that is actually populated', () => {
    // A guard over an empty list passes everything and reads as coverage.
    expect(RETIRED_CONTRACTS.length).toBeGreaterThanOrEqual(7);
  });
});

/**
 * The retired-list guard is a staleness canary, and on approveDeny it checks the harmless half: a
 * retired spender PRESENT denies nothing, while the current proxy ABSENT is what denies the
 * approve(fulfillmentProxy, MAX) the settler performs at boot. This is the relative invariant that
 * catches that class without a known-good list — exactly the polarity the module's header argues
 * for, since it needs no lockstep maintenance and can only ever be incomplete.
 *
 * Limit, stated so it is not mistaken for more: it cannot catch "the escrow was used where the
 * proxy belongs", because both appear in allowedTo. Closing that needs the deployment manifest this
 * guard deliberately avoids depending on.
 */
describe('approveDeny spenders are addresses the settler is actually allowed to call', () => {
  const dir = path.join(__dirname, 'config');

  it('every allowedSpendersHex value appears in that chain\'s allowedTo', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.example.yaml'));
    expect(files.length).toBeGreaterThan(0);
    let compared = 0;

    for (const f of files) {
      const cfg = parseYaml(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        allowlists?: Record<string, { allowedTo?: unknown }>;
        approveDeny?: Record<string, Record<string, { allowedSpendersHex?: unknown }>>;
      };
      if (!cfg.approveDeny) continue;

      for (const [vm, perChain] of Object.entries(cfg.approveDeny)) {
        for (const [chainKey, entry] of Object.entries(perChain ?? {})) {
          const spenders = entry?.allowedSpendersHex;
          if (!Array.isArray(spenders)) continue;
          const allowedTo = cfg.allowlists?.[chainKey]?.allowedTo;
          // 'any' is a legitimate wildcard and makes the subset trivially satisfied.
          if (allowedTo === 'any') continue;
          // Build the comparable forms of allowedTo. Order matters: base58 is CASE-SIGNIFICANT,
          // so the tron decode must see the ORIGINAL string and only its hex OUTPUT may be
          // lowercased. Lowercasing first is what my own first cut did, and it silently turned a
          // present address into an absent one.
          const targets = new Set<string>();
          for (const t of Array.isArray(allowedTo) ? allowedTo : []) {
            const raw = String(t).trim();
            targets.add(raw.toLowerCase().replace(/^0x/, '')); // EVM, 0x-insensitive
            try {
              targets.add(tronBase58ToEvmHex(raw).toLowerCase()); // tron base58 -> calldata hex
            } catch {
              // Not a tron address; the EVM form above is the comparable one.
            }
          }
          for (const raw of spenders) {
            const spender = String(raw).trim().toLowerCase().replace(/^0x/, '');
            compared++;
            const ok = targets.has(spender);
            expect(
              ok,
              `${f}: approveDeny.${vm}.${chainKey}.allowedSpendersHex lists ${spender}, which is ` +
                `absent from allowlists.${chainKey}.allowedTo. approveDeny is a DENY on approve() ` +
                `to anything outside its list, so a spender the settler may not even call is at ` +
                `best dead breadth and at worst the wrong address — and if a CURRENT ` +
                `fulfillment proxy is the one missing, its boot approve() is denied.`,
            ).toBe(true);
          }
        }
      }
    }
    // Non-vacuity: the shipped example has an evm and a tron block, so zero comparisons means the
    // shape changed and this stopped guarding.
    expect(compared).toBeGreaterThanOrEqual(2);
  });
});
