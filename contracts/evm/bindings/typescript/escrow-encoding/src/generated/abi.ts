// GENERATED FILE -- DO NOT EDIT.
//
// Written by scripts/generate-abi.mjs from contracts/evm/source/generated/abi. Run
// `pnpm run generate:abi` to regenerate; generated-abi.test.ts fails if it has drifted.

/**
 * Full ABI of the deployed EVM Escrow contract: functions, events, errors. TVM emits a
 * subset of these events with identical shapes, so it decodes Tron logs too; TVM-only
 * functions and errors are not in it.
 */
export const ESCROW_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "permit2",
        "type": "address",
        "internalType": "contract IPermit2"
      },
      {
        "name": "defaultAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DEFAULT_ADMIN_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PAUSER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "TOKEN_CONFIG_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "TREASURER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptDefaultAdminTransfer",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowTokenAndSetFeeConfig",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "feePercentage",
        "type": "uint88",
        "internalType": "uint88"
      },
      {
        "name": "minFee",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "maxFee",
        "type": "uint80",
        "internalType": "uint80"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beginDefaultAdminTransfer",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelDefaultAdminTransfer",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "changeDefaultAdminDelay",
    "inputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "clearTokenFeeConfig",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "defaultAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "defaultAdminDelay",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "defaultAdminDelayIncreaseWait",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [
      {
        "name": "depositInput",
        "type": "tuple",
        "internalType": "struct IEscrow.DepositInput",
        "components": [
          {
            "name": "permit",
            "type": "tuple",
            "internalType": "struct ISignatureTransfer.PermitTransferFrom",
            "components": [
              {
                "name": "permitted",
                "type": "tuple",
                "internalType": "struct ISignatureTransfer.TokenPermissions",
                "components": [
                  {
                    "name": "token",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amount",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "nonce",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "deadline",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "depositor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "depositWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.DepositWitness",
            "components": [
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destination",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "depositSignature",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "reserveWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.ReserveWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "sourceAmount",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "reserveSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "depositMany",
    "inputs": [
      {
        "name": "depositInputs",
        "type": "tuple[]",
        "internalType": "struct IEscrow.DepositInput[]",
        "components": [
          {
            "name": "permit",
            "type": "tuple",
            "internalType": "struct ISignatureTransfer.PermitTransferFrom",
            "components": [
              {
                "name": "permitted",
                "type": "tuple",
                "internalType": "struct ISignatureTransfer.TokenPermissions",
                "components": [
                  {
                    "name": "token",
                    "type": "address",
                    "internalType": "address"
                  },
                  {
                    "name": "amount",
                    "type": "uint256",
                    "internalType": "uint256"
                  }
                ]
              },
              {
                "name": "nonce",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "deadline",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "depositor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "depositWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.DepositWitness",
            "components": [
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destination",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "depositSignature",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "reserveWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.ReserveWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "sourceAmount",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "reserveSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "depositIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "determineFee",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "tokenConfig",
        "type": "tuple",
        "internalType": "struct ITokenConfig.TokenConfig",
        "components": [
          {
            "name": "feePercentage6Decimals",
            "type": "uint88",
            "internalType": "uint88"
          },
          {
            "name": "maxFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "minFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "tokenDecimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "feeAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "directDeposit",
    "inputs": [
      {
        "name": "input",
        "type": "tuple",
        "internalType": "struct IEscrow.DirectDepositInput",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "depositWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.DepositWitness",
            "components": [
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destination",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              }
            ]
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "disallowToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAllowedTokens",
    "inputs": [],
    "outputs": [
      {
        "name": "allowedTokens",
        "type": "address[]",
        "internalType": "contract IERC20[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getDepositHash",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getDirectDepositFeeConfig",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "tokenConfig",
        "type": "tuple",
        "internalType": "struct ITokenConfig.TokenConfig",
        "components": [
          {
            "name": "feePercentage6Decimals",
            "type": "uint88",
            "internalType": "uint88"
          },
          {
            "name": "maxFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "minFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "tokenDecimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getFeeRevenue",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "outputs": [
      {
        "name": "revenue",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRoleAdmin",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTokenConfig",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "outputs": [
      {
        "name": "tokenConfig",
        "type": "tuple",
        "internalType": "struct ITokenConfig.TokenConfig",
        "components": [
          {
            "name": "feePercentage6Decimals",
            "type": "uint88",
            "internalType": "uint88"
          },
          {
            "name": "maxFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "minFee6Decimals",
            "type": "uint80",
            "internalType": "uint80"
          },
          {
            "name": "tokenDecimals",
            "type": "uint8",
            "internalType": "uint8"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grantRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "i_permit2",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IPermit2"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isTokenAllowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "outputs": [
      {
        "name": "isAllowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingDefaultAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingDefaultAdminDelay",
    "inputs": [],
    "outputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "refund",
    "inputs": [
      {
        "name": "refundInput",
        "type": "tuple",
        "internalType": "struct IEscrow.RefundInput",
        "components": [
          {
            "name": "refundWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.RefundWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destinationHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositor",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "feeAmount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "refundSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "refundMany",
    "inputs": [
      {
        "name": "refundInputs",
        "type": "tuple[]",
        "internalType": "struct IEscrow.RefundInput[]",
        "components": [
          {
            "name": "refundWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.RefundWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destinationHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositor",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "feeAmount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "refundSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "refundUnreserved",
    "inputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IEscrow.RefundUnreservedInput",
        "components": [
          {
            "name": "depositId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "depositRequestHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destinationHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reserver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "releaser",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "release",
    "inputs": [
      {
        "name": "releaseInput",
        "type": "tuple",
        "internalType": "struct IEscrow.ReleaseInput",
        "components": [
          {
            "name": "releaseWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.ReleaseWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destinationHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositor",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "feeAmount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "releaseSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "releaseMany",
    "inputs": [
      {
        "name": "releaseInputs",
        "type": "tuple[]",
        "internalType": "struct IEscrow.ReleaseInput[]",
        "components": [
          {
            "name": "releaseWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.ReleaseWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destinationHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "depositor",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "token",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "amount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "feeAmount",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "releaseSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renounceRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reserve",
    "inputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IEscrow.ReserveInput",
        "components": [
          {
            "name": "depositor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "depositWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.DepositWitness",
            "components": [
              {
                "name": "depositRequestHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "destination",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "reserver",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "releaser",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "reserveWitness",
            "type": "tuple",
            "internalType": "struct IEscrow.ReserveWitness",
            "components": [
              {
                "name": "depositId",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "quoteHash",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "settler",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "sourceAmount",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "reserveSignature",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rollbackDefaultAdminDelay",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTokenFeeConfig",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "feePercentage",
        "type": "uint88",
        "internalType": "uint88"
      },
      {
        "name": "minFee",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "maxFee",
        "type": "uint80",
        "internalType": "uint80"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdrawFeeRevenue",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "DefaultAdminDelayChangeCanceled",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminDelayChangeScheduled",
    "inputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "effectSchedule",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminTransferCanceled",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminTransferScheduled",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "acceptSchedule",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DepositCommitments",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "depositRequestHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "destinationHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DepositReserved",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "quoteHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "quoteHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "depositor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reserver",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "releaser",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DepositedMany",
    "inputs": [
      {
        "name": "depositIds",
        "type": "bytes32[]",
        "indexed": false,
        "internalType": "bytes32[]"
      },
      {
        "name": "depositWitnesses",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct IEscrow.DepositWitness[]",
        "components": [
          {
            "name": "depositRequestHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destination",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "reserver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "releaser",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "reserveWitnesses",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct IEscrow.ReserveWitness[]",
        "components": [
          {
            "name": "depositId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "settler",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "sourceAmount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "feeAmounts",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeRevenueWithdrawn",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "contract IERC20"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Refunded",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "depositor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RefundedMany",
    "inputs": [
      {
        "name": "refundWitnesses",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct IEscrow.RefundWitness[]",
        "components": [
          {
            "name": "depositId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "depositRequestHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destinationHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "depositor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reserver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "releaser",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "settler",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Released",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ReleasedMany",
    "inputs": [
      {
        "name": "releaseWitnesses",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct IEscrow.ReleaseWitness[]",
        "components": [
          {
            "name": "depositId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "depositRequestHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "destinationHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "depositor",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "feeAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "reserver",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "releaser",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "settler",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleAdminChanged",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleGranted",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleRevoked",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenAllowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "contract IERC20"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenDisallowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "contract IERC20"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenFeesCleared",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "contract IERC20"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenFeesUpdated",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "contract IERC20"
      },
      {
        "name": "feePercentage",
        "type": "uint88",
        "indexed": false,
        "internalType": "uint88"
      },
      {
        "name": "minFee",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      },
      {
        "name": "maxFee",
        "type": "uint80",
        "indexed": false,
        "internalType": "uint80"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Unpaused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlEnforcedDefaultAdminDelay",
    "inputs": [
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ]
  },
  {
    "type": "error",
    "name": "AccessControlEnforcedDefaultAdminRules",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlInvalidDefaultAdmin",
    "inputs": [
      {
        "name": "defaultAdmin",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "CouldNotDisallowToken",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ]
  },
  {
    "type": "error",
    "name": "DepositAlreadyExists",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "DepositAmountCannotBeZero",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DepositCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DepositNotFound",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "DepositRequestHashCannotBeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DestinationCannotBeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DestinationTooLong",
    "inputs": [
      {
        "name": "length",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeeExceedsDepositAmount",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "feeAmount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "FeePercentageCannotBeZeroWhenMaxFeeIsSet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeePercentageExceedsMaximum",
    "inputs": [
      {
        "name": "feePercentage6Decimals",
        "type": "uint88",
        "internalType": "uint88"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSourceAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidWitnessValues",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "expectedHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "passedHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "MaxFeeNotRepresentable",
    "inputs": [
      {
        "name": "maxFee6Decimals",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "MinFeeCannotBeGreaterThanMaxFee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MinFeeNotRepresentable",
    "inputs": [
      {
        "name": "minFee6Decimals",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "tokenDecimals",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "NoFeesToWithdraw",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ]
  },
  {
    "type": "error",
    "name": "NonExactTransfer",
    "inputs": [
      {
        "name": "expected",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "received",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NonceAlreadyUsed",
    "inputs": [
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotReserved",
    "inputs": [
      {
        "name": "depositId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "Permit2CannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteHashCannotBeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecipientCannotBeSelf",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecipientCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReleaserCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReserverCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SettlerCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TokenAlreadyAllowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ]
  },
  {
    "type": "error",
    "name": "TokenCannotBeZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TokenDecimalsCannotBeZero",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TokenDecimalsExceedMaximum",
    "inputs": [
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "maximum",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "TokenDecimalsMismatch",
    "inputs": [
      {
        "name": "provided",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "actual",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "type": "error",
    "name": "TokenNotAllowed",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ]
  }
] as const;

/**
 * Full ABI of the deployed EVM FulfillmentProxy contract: functions, events, errors. TVM emits a
 * subset of these events with identical shapes, so it decodes Tron logs too; TVM-only
 * functions and errors are not in it.
 */
export const FULFILLMENT_PROXY_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "defaultAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DEFAULT_ADMIN_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PAUSER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SETTLER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptDefaultAdminTransfer",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "authorizeFulfillment",
    "inputs": [
      {
        "name": "quoteHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "authorizationHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beginDefaultAdminTransfer",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelDefaultAdminTransfer",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "changeDefaultAdminDelay",
    "inputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "defaultAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "defaultAdminDelay",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "defaultAdminDelayIncreaseWait",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fulfill",
    "inputs": [
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct IFulfillmentProxy.Fulfillment",
        "components": [
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "fulfillMany",
    "inputs": [
      {
        "name": "params",
        "type": "tuple[]",
        "internalType": "struct IFulfillmentProxy.Fulfillment[]",
        "components": [
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getRoleAdmin",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grantRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingDefaultAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingDefaultAdminDelay",
    "inputs": [],
    "outputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "rollbackDefaultAdminDelay",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "s_settlerAllowlistEnforced",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setSettlerAllowlistEnforced",
    "inputs": [
      {
        "name": "enforced",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "strictFulfill",
    "inputs": [
      {
        "name": "params",
        "type": "tuple",
        "internalType": "struct IFulfillmentProxy.Fulfillment",
        "components": [
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "DefaultAdminDelayChangeCanceled",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminDelayChangeScheduled",
    "inputs": [
      {
        "name": "newDelay",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "effectSchedule",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminTransferCanceled",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DefaultAdminTransferScheduled",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "acceptSchedule",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Fulfilled",
    "inputs": [
      {
        "name": "quoteHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "timestamp",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FulfilledMany",
    "inputs": [
      {
        "name": "fulfillments",
        "type": "tuple[]",
        "indexed": false,
        "internalType": "struct IFulfillmentProxy.Fulfillment[]",
        "components": [
          {
            "name": "quoteHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "to",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "timestamp",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FulfillmentAuthorized",
    "inputs": [
      {
        "name": "authorizationHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "quoteHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleAdminChanged",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleGranted",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleRevoked",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SettlerAllowlistEnforcementSet",
    "inputs": [
      {
        "name": "enforced",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Unpaused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlEnforcedDefaultAdminDelay",
    "inputs": [
      {
        "name": "schedule",
        "type": "uint48",
        "internalType": "uint48"
      }
    ]
  },
  {
    "type": "error",
    "name": "AccessControlEnforcedDefaultAdminRules",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlInvalidDefaultAdmin",
    "inputs": [
      {
        "name": "defaultAdmin",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "AlreadyFulfilled",
    "inputs": [
      {
        "name": "quoteHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "DeadlineExpired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "currentTime",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "EmptyFulfillmentBatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteHashCannotBeEmpty",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
