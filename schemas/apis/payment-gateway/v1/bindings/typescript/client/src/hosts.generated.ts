// GENERATED FILE — DO NOT EDIT.
//
// Written by schemas/scripts/gen-hosts.mjs from schemas/apis/hosts.yaml.
// Run `make -C schemas generate-hosts` to regenerate; `make -C schemas check-hosts`
// fails if it has drifted.

export const hosts = {
  paymentGateway: {
    mainnet: "https://payment-gw.production-mainnet.atum.xyz",
    testnet: "https://payment-gw.production-testnet.atum.xyz",
    local: "http://localhost:8080",
  },
} as const;

export const x402BasePath = "/x402/v1";

/** Zero-config client default: testnet, never mainnet. */
export const defaultGateway = hosts.paymentGateway.testnet;
