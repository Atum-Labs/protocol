#!/usr/bin/env node
/**
 * Fail the Tron image build unless the COMPILED escrow pins the widened witness typehashes.
 *
 * Why this exists: this image used to compile contracts/tvm/repo, the retiring per-VM submodule that
 * was never updated to the widened witnesses. The entrypoint then `tronbox migrate`s whatever was
 * compiled, so the Tron devnet came up with a V1 escrow while the settler's Tron plugin signs the
 * eleven-member witnesses. Permit2 takes the witness as an opaque bytes32 and cannot detect the
 * disagreement, so nothing failed at build time — every deposit just reverted at signature
 * verification.
 *
 * Why it checks the COMPILED ARTIFACT rather than a deployed contract: unlike the EVM fork image,
 * which deploys at build time and bakes an anvil state dump, this image only *compiles* at build time
 * — deployment happens in the entrypoint at container start. The artifact is therefore the earliest
 * (and the only build-time) place the source-selection mistake is visible.
 *
 * Why it derives the hashes instead of hard-coding them: a hard-coded expectation would still pass if
 * someone renamed a member in the type string and updated the constant to match. Deriving keccak from
 * the member list the CONTRACT IS SUPPOSED TO PIN, then requiring it in the bytecode, ties the two
 * together. (`bytes32 constant` compiles to a PUSH32, so the value is literally in the code.)
 *
 * Both directions are asserted: the V2 hashes must be PRESENT and the pre-widening ones ABSENT.
 * "V2 present" alone would pass on a contract that supports both shapes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { TronWeb } = require('tronweb');

const ARTIFACT = path.join(__dirname, '..', 'build', 'contracts', 'Escrow.json');

const V2_WITNESSES = [
  [
    'DepositWitness',
    'DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)',
  ],
  [
    'ReserveWitness',
    'ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)',
  ],
  [
    'ReleaseWitness',
    'ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)',
  ],
  [
    'RefundWitness',
    'RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)',
  ],
];

const V1_WITNESSES = [
  ['V1 DepositWitness', 'DepositWitness(address reserver,address releaser)'],
  ['V1 ReserveWitness', 'ReserveWitness(bytes32 paymentId,address settler)'],
];

function keccakHex(typeString) {
  // TronWeb.sha3 is keccak256 (not SHA3-256); strip 0x and lowercase for a substring search.
  return TronWeb.sha3(typeString, true).replace(/^0x/, '').toLowerCase();
}

function main() {
  if (!fs.existsSync(ARTIFACT)) {
    console.error(`FATAL: ${ARTIFACT} not found — did \`tronbox compile\` run?`);
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  // tronbox writes `bytecode` (creation) and `deployedBytecode`; the typehash constants appear in
  // both, but check them together so a layout change in either cannot make this silently vacuous.
  const code = `${artifact.bytecode || ''}${artifact.deployedBytecode || ''}`.toLowerCase();
  if (code.length < 64) {
    console.error('FATAL: compiled Escrow artifact carries no bytecode to inspect.');
    process.exit(1);
  }

  let failed = false;

  for (const [label, typeString] of V2_WITNESSES) {
    const want = keccakHex(typeString);
    if (code.includes(want)) {
      console.log(`  ok: ${label} 0x${want.slice(0, 16)}... present`);
    } else {
      console.error(`FATAL: compiled escrow does NOT pin the widened ${label} typehash (0x${want}).`);
      console.error('       Expected the contracts from protocol/contracts/tvm/source. Deploying this');
      console.error('       image would revert every deposit at Permit2 signature verification.');
      failed = true;
    }
  }

  for (const [label, typeString] of V1_WITNESSES) {
    const want = keccakHex(typeString);
    if (code.includes(want)) {
      console.error(`FATAL: compiled escrow still pins the PRE-WIDENING ${label} typehash (0x${want}).`);
      console.error('       The contract source this image compiled predates the witness widening.');
      failed = true;
    } else {
      console.log(`  ok: ${label} 0x${want.slice(0, 16)}... absent as expected`);
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log('Compiled Tron escrow pins the widened witness typehashes.');
}

main();
