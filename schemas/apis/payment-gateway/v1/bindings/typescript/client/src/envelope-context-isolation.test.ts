import { buildEnvelope, signerFromEthersWallet } from './signing';
import { PAYMENT_REQUEST_ENVELOPE_CONTEXT } from './pre-context.generated';
import { ethers } from 'ethers';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new ethers.Wallet(KEY);
const account = wallet.address.toLowerCase();
const holder = `did:pkh:eip155:1:${account}`;

function opts() {
  return {
    holderVCs: [
      {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:web:devnet.atum.network',
        credentialSubject: { id: holder },
        proof: {
          type: 'EcdsaSecp256k1RecoverySignature2020',
          created: '2026-04-01T00:00:00.000Z',
          verificationMethod: `${holder}#blockchainAccountId`,
          proofPurpose: 'assertionMethod',
        },
      },
    ],
    signer: signerFromEthersWallet(wallet),
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: 'req-1',
    domain: 'did:web:devnet.atum.network',
    created: '2026-04-01T00:00:00.000Z',
  } as Parameters<typeof buildEnvelope>[0];
}

// The generated context is module state shared by every call. Handing the live object to the
// signer would mean a caller that mutates it changes what this package signs for the rest of
// the process — silently, since only the signature differs and the document still looks right.
// buildEnvelope clones it; this pins that.
it('the exported context cannot be mutated, so what is signed cannot be changed', async () => {
  const before = (await buildEnvelope(opts())) as Record<string, any>;

  // Frozen: the assignment throws in a module (strict mode) rather than succeeding quietly.
  expect(() => {
    (PAYMENT_REQUEST_ENVELOPE_CONTEXT as Record<string, unknown>)['@context'] = { evil: 'x' };
  }).toThrow();

  // Nested too — a shallow freeze would leave the term definitions writable, which is where
  // a meaning-changing edit would actually go.
  const inner = PAYMENT_REQUEST_ENVELOPE_CONTEXT['@context'] as Record<string, unknown>;
  expect(() => {
    inner.verifiableCredential = { '@id': 'https://attacker.example/#vc' };
  }).toThrow();

  const after = (await buildEnvelope(opts())) as Record<string, any>;
  expect(after.proof.jws).toBe(before.proof.jws);
});

it('the signer is handed a clone, so the processor cannot mutate the shared context', async () => {
  // The other direction: buildEnvelope passes structuredClone, so even a JSON-LD processor
  // that wrote into the context it was given could not reach module state.
  const snapshot = JSON.stringify(PAYMENT_REQUEST_ENVELOPE_CONTEXT);
  await buildEnvelope(opts());
  expect(JSON.stringify(PAYMENT_REQUEST_ENVELOPE_CONTEXT)).toBe(snapshot);
});
