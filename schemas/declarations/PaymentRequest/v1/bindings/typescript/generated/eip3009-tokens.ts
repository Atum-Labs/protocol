// Generated from schemas/declarations/PaymentRequest/v1/eip3009-tokens.json by
// generate-eip3009-tokens.mjs. Do not edit; edit the JSON and run make generate-ts-bindings.

export interface Eip3009Token {
  readonly symbol: string;
  readonly address: string;
}

/** Tokens that implement EIP-3009 transferWithAuthorization, keyed by CAIP-2 chain ID. */
export const EIP3009_TOKENS: Readonly<Record<string, readonly Eip3009Token[]>> = {
  "eip155:1": [
    {
      "symbol": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    },
    {
      "symbol": "PYUSD",
      "address": "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8"
    }
  ],
  "eip155:10": [
    {
      "symbol": "USDC",
      "address": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
    }
  ],
  "eip155:137": [
    {
      "symbol": "USDC",
      "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
    }
  ],
  "eip155:8453": [
    {
      "symbol": "USDC",
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  ],
  "eip155:42161": [
    {
      "symbol": "USDC",
      "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
    },
    {
      "symbol": "USDT0",
      "address": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
    },
    {
      "symbol": "PYUSD",
      "address": "0x46850aD61C2B7d64d08c9C754F45254596696984"
    }
  ],
  "eip155:42220": [
    {
      "symbol": "USDC",
      "address": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C"
    },
    {
      "symbol": "USDT",
      "address": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"
    }
  ],
  "eip155:43114": [
    {
      "symbol": "USDC",
      "address": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"
    }
  ],
  "eip155:11155111": [
    {
      "symbol": "USDC",
      "address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    },
    {
      "symbol": "PYUSD",
      "address": "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9"
    }
  ],
  "eip155:11155420": [
    {
      "symbol": "USDC",
      "address": "0x5fd84259d66Cd46123540766Be93DFE6D43130D7"
    }
  ],
  "eip155:80002": [
    {
      "symbol": "USDC",
      "address": "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582"
    }
  ],
  "eip155:84532": [
    {
      "symbol": "USDC",
      "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    }
  ],
  "eip155:421614": [
    {
      "symbol": "USDC",
      "address": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
    },
    {
      "symbol": "PYUSD",
      "address": "0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1"
    }
  ],
  "eip155:43113": [
    {
      "symbol": "USDC",
      "address": "0x5425890298aed601595a70AB815c96711a31Bc65"
    }
  ],
  "eip155:11142220": [
    {
      "symbol": "USDC",
      "address": "0x01C5C0122039549AD1493B8220cABEdD739BC44E"
    },
    {
      "symbol": "USDT",
      "address": "0xd077A400968890Eacc75cdc901F0356c943e4fDb"
    }
  ]
};
