module.exports = {
  networks: {
    mainnet: {
      // Don't put your private key here:
      privateKey: process.env.PRIVATE_KEY_MAINNET,
      /**
       * Create a .env file in the project root (it must be gitignored) containing something like
       *
       *   PRIVATE_KEY_MAINNET=4E7FEC...656243
       *
       * Then, run the migration with:
       *
       *   source ../../.env && tronbox migrate --network mainnet
       */
      userFeePercentage: 100,
      feeLimit: 15000000000,
      // The mainnet endpoint is plain TronGrid, not Alchemy, and the API key is a SEPARATE
      // value sent as a TRON-PRO-API-KEY header rather than embedded in the URL. Read
      // both from the environment so no endpoint or key is ever committed here.
      fullHost: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : undefined,
      network_id: '1'
    },
    shasta: {
      // Obtain test coin at https://shasta.tronex.io/
      privateKey: process.env.PRIVATE_KEY_SHASTA,
      userFeePercentage: 50,
      feeLimit: 15000000000,
      fullHost: 'https://api.shasta.trongrid.io',
      network_id: '2'
    },
    nile: {
      // Obtain test coin at https://nileex.io/join/getJoinPage
      privateKey: process.env.PRIVATE_KEY_NILE,
      userFeePercentage: 100,
      feeLimit: 15000000000,
      fullHost: 'https://nile.trongrid.io',
      network_id: '3'
    },
    development: {
      // For tronbox/tre docker image
      // Using the consistent default private key when useDefaultPrivateKey=true
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
      userFeePercentage: 0,
      // 1000 TRX, NOT the 15000 the public networks above allow.
      //
      // A local TRE node enforces the protocol default MAX_FEE_LIMIT of 1e9 SUN; only mainnet has
      // raised it to 15e9 by committee proposal. With 15e9 here EVERY local deployment was rejected
      // at broadcast with "feeLimit must be >= 0 and <= 1000000000" — including the Migrations
      // contract, so no migration ever completed, so no test ever ran. Verified in CI as well as
      // locally: the TVM job's "TronBox tests" step has been printing that exact error and passing.
      feeLimit: 1000000000,
      // deploy:local and the `tronbox migrate` it spawns both read this, so the settler e2e can
      // point them at its own node. Not TRON_RPC_URL, which is mainnet's.
      fullHost: process.env.TRON_LOCAL_RPC_URL || 'http://127.0.0.1:9090',
      network_id: '9'
    }
  },
  compilers: {
    solc: {
      version: '0.8.23',
      // An object with the same schema as the settings entry in the Input JSON.
      // See https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description
      settings: {
        optimizer: {
          enabled: true,
          runs: 4294967295
        },
        viaIR: true,
        metadata: {
          bytecodeHash: 'none',
          appendCBOR: false
        }
      }
    }
  }
};
