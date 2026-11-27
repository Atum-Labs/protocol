/**
 * Whether a `tronbox migrate --reset` really deployed.
 *
 * tronbox has exited 0 after an aborted migration (see run-tronbox-tests.sh), and a skipped one
 * leaves the previous run's addresses in build/. Tron derives a new contract's address from its
 * creation transaction, so a real redeploy never repeats one: only fresh addresses prove this run
 * deployed the contracts.
 *
 * @param {string[]} names - the contracts that must have been redeployed
 * @param {Object<string, string|undefined>} before - each one's build/ address before migrating
 * @param {Object<string, string|undefined>} after - each one's build/ address after migrating
 * @returns {Object<string, string>} the fresh address of each of `names`
 */
function assertFreshDeployment(names, before, after) {
  const fresh = {};
  for (const name of names) {
    const address = after[name];
    if (!address || address === before[name]) {
      throw new Error(`tronbox migrate did not deploy a fresh ${name} (build/contracts/${name}.json has ${address || 'none'})`);
    }
    fresh[name] = address;
  }
  return fresh;
}

module.exports = { assertFreshDeployment };
