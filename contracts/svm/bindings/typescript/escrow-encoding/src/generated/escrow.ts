/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/escrow.json`.
 */
export type Escrow = {
  "address": "44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs",
  "metadata": {
    "name": "escrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "acceptDefaultAdminTransfer",
      "discriminator": [
        44,
        180,
        174,
        250,
        31,
        189,
        187,
        8
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "allowMint",
      "discriminator": [
        240,
        28,
        240,
        70,
        124,
        240,
        245,
        225
      ],
      "accounts": [
        {
          "name": "tokenConfigAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAccount",
          "docs": [
            "The mint to allowlist"
          ]
        },
        {
          "name": "mintFeeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mintAccount"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "beginDefaultAdminTransfer",
      "discriminator": [
        124,
        58,
        200,
        115,
        36,
        158,
        121,
        105
      ],
      "accounts": [
        {
          "name": "defaultAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "clearMintFeeConfig",
      "discriminator": [
        147,
        76,
        233,
        191,
        196,
        52,
        94,
        57
      ],
      "accounts": [
        {
          "name": "tokenConfigAuthority",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintFeeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mint_fee_config.mint",
                "account": "mintFeeConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createDelegate",
      "discriminator": [
        27,
        99,
        122,
        21,
        236,
        229,
        58,
        10
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "mintFeeConfig",
          "docs": [
            "Mint fee configuration - must exist for allowlist"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "escrowDelegate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "authorityAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "delegateSigner",
          "type": "pubkey"
        },
        {
          "name": "remainingCapacity",
          "type": "u64"
        },
        {
          "name": "maxTransferSize",
          "type": "u64"
        },
        {
          "name": "expiration",
          "type": "u64"
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "escrowDelegate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "escrow_delegate.allowed_mint",
                "account": "escrowDelegate"
              }
            ]
          }
        },
        {
          "name": "authority"
        },
        {
          "name": "replayBucket",
          "writable": true
        },
        {
          "name": "authorityAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "deposit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "depositHash"
              }
            ]
          }
        },
        {
          "name": "escrowAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "deposit"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintFeeConfig",
          "docs": [
            "Mint fee configuration - must exist for allowlist"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "depositRequestHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "destinationHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "reserver",
          "type": "pubkey"
        },
        {
          "name": "releaser",
          "type": "pubkey"
        },
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "issuedAt",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "u64"
        },
        {
          "name": "depositHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "disallowMint",
      "discriminator": [
        75,
        176,
        193,
        187,
        34,
        158,
        118,
        121
      ],
      "accounts": [
        {
          "name": "tokenConfigAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintFeeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mint_fee_config.mint",
                "account": "mintFeeConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initializeProtocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "docs": [
            "The escrow program executable account"
          ],
          "address": "44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs"
        },
        {
          "name": "programData",
          "docs": [
            "The program metadata account. For loader-v3 this is ProgramData PDA; for",
            "loader-v4 this is the executable program account itself."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "defaultAdmin",
          "type": "pubkey"
        },
        {
          "name": "tokenConfigAuthority",
          "type": "pubkey"
        },
        {
          "name": "treasurer",
          "type": "pubkey"
        },
        {
          "name": "pauser",
          "type": "pubkey"
        },
        {
          "name": "clusterId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "defaultAdminDelaySeconds",
          "type": "u32"
        }
      ]
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "pauser",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "refund",
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "deposit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "deposit.deposit_hash",
                "account": "depositInfo"
              }
            ]
          }
        },
        {
          "name": "escrowAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "deposit"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "depositor"
        },
        {
          "name": "depositorAta",
          "docs": [
            "Depositor's ATA, created if missing to prevent stuck funds. Checked by address in the",
            "handler, for the same reason as in `Release`."
          ],
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "memoProgram",
          "docs": [
            "Sends the memo a depositor ATA that requires incoming memos needs before each credit."
          ],
          "address": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        }
      ],
      "args": []
    },
    {
      "name": "release",
      "discriminator": [
        253,
        249,
        15,
        206,
        28,
        127,
        193,
        241
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "deposit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "deposit.deposit_hash",
                "account": "depositInfo"
              }
            ]
          }
        },
        {
          "name": "escrowAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "deposit"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "recipient",
          "docs": [
            "The recipient from deposit.recipient"
          ]
        },
        {
          "name": "recipientAta",
          "docs": [
            "Recipient's ATA - created if missing"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "depositor",
          "docs": [
            "The original depositor receiving any surplus tokens left in escrow."
          ]
        },
        {
          "name": "depositorAta",
          "docs": [
            "Depositor ATA used to return surplus tokens. Checked by address in the handler and created if",
            "missing. Not typed as a token account: a classic SPL owner change by the depositor would",
            "otherwise fail account validation and block the release."
          ],
          "writable": true
        },
        {
          "name": "treasurer",
          "docs": [
            "The treasurer from protocol_config"
          ]
        },
        {
          "name": "treasuryAta",
          "docs": [
            "Treasury ATA - created if missing (even for fee=0)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "treasurer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "memoProgram",
          "docs": [
            "Sends the memo a depositor ATA that requires incoming memos needs before each credit."
          ],
          "address": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        }
      ],
      "args": []
    },
    {
      "name": "renounceDelegate",
      "discriminator": [
        173,
        220,
        23,
        201,
        23,
        223,
        231,
        176
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "escrowDelegate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "escrow_delegate.authority",
                "account": "escrowDelegate"
              },
              {
                "kind": "account",
                "path": "escrow_delegate.allowed_mint",
                "account": "escrowDelegate"
              }
            ]
          }
        },
        {
          "name": "delegateSigner",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "reserve",
      "discriminator": [
        92,
        99,
        244,
        209,
        28,
        65,
        213,
        157
      ],
      "accounts": [
        {
          "name": "deposit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "deposit.deposit_hash",
                "account": "depositInfo"
              }
            ]
          }
        },
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "recipient",
          "type": "pubkey"
        },
        {
          "name": "quoteHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "sourceAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "revokeDelegate",
      "discriminator": [
        142,
        66,
        98,
        126,
        102,
        60,
        92,
        163
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "docs": [
            "Protocol configuration - required for pause check"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "escrowDelegate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "escrow_delegate.authority",
                "account": "escrowDelegate"
              },
              {
                "kind": "account",
                "path": "escrow_delegate.allowed_mint",
                "account": "escrowDelegate"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "authorityAta",
          "docs": [
            "The authority's token account where delegation was approved"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "escrow_delegate.allowed_mint",
                "account": "escrowDelegate"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "setDefaultAdminDelaySeconds",
      "discriminator": [
        30,
        19,
        187,
        134,
        127,
        62,
        166,
        1
      ],
      "accounts": [
        {
          "name": "defaultAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newDelaySeconds",
          "type": "u32"
        }
      ]
    },
    {
      "name": "setMintFeeConfig",
      "discriminator": [
        114,
        21,
        164,
        205,
        186,
        108,
        59,
        216
      ],
      "accounts": [
        {
          "name": "tokenConfigAuthority",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAccount",
          "docs": [
            "The mint (for Token-2022 validation)"
          ]
        },
        {
          "name": "mintFeeConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  102,
                  101,
                  101,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "mint_fee_config.mint",
                "account": "mintFeeConfig"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "feePercentage6",
          "type": "u64"
        },
        {
          "name": "minFee6",
          "type": "u64"
        },
        {
          "name": "maxFee6",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setPauser",
      "discriminator": [
        22,
        198,
        152,
        61,
        2,
        13,
        145,
        238
      ],
      "accounts": [
        {
          "name": "defaultAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newPauser",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setTokenConfigAuthority",
      "discriminator": [
        47,
        44,
        31,
        224,
        21,
        181,
        23,
        169
      ],
      "accounts": [
        {
          "name": "defaultAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setTreasurer",
      "discriminator": [
        100,
        87,
        30,
        190,
        191,
        14,
        164,
        98
      ],
      "accounts": [
        {
          "name": "defaultAdmin",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newTreasurer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "pauser",
          "signer": true
        },
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "depositInfo",
      "discriminator": [
        101,
        57,
        220,
        248,
        249,
        192,
        118,
        196
      ]
    },
    {
      "name": "escrowDelegate",
      "discriminator": [
        254,
        94,
        75,
        129,
        75,
        230,
        49,
        97
      ]
    },
    {
      "name": "mintFeeConfig",
      "discriminator": [
        212,
        211,
        101,
        112,
        98,
        36,
        79,
        2
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "replayBucket",
      "discriminator": [
        131,
        240,
        205,
        44,
        126,
        220,
        195,
        8
      ]
    }
  ],
  "events": [
    {
      "name": "defaultAdminDelayUpdated",
      "discriminator": [
        222,
        149,
        51,
        219,
        253,
        219,
        19,
        47
      ]
    },
    {
      "name": "defaultAdminTransferBegun",
      "discriminator": [
        236,
        58,
        7,
        225,
        130,
        45,
        38,
        165
      ]
    },
    {
      "name": "defaultAdminTransferred",
      "discriminator": [
        204,
        233,
        198,
        81,
        52,
        53,
        78,
        172
      ]
    },
    {
      "name": "delegateRenounced",
      "discriminator": [
        101,
        80,
        53,
        194,
        31,
        2,
        190,
        58
      ]
    },
    {
      "name": "delegateRevoked",
      "discriminator": [
        10,
        200,
        133,
        29,
        238,
        207,
        193,
        124
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "mintAllowed",
      "discriminator": [
        80,
        212,
        130,
        120,
        125,
        216,
        111,
        240
      ]
    },
    {
      "name": "mintDisallowed",
      "discriminator": [
        197,
        121,
        232,
        50,
        39,
        80,
        141,
        148
      ]
    },
    {
      "name": "mintFeesCleared",
      "discriminator": [
        234,
        55,
        246,
        79,
        81,
        6,
        24,
        246
      ]
    },
    {
      "name": "mintFeesUpdated",
      "discriminator": [
        44,
        199,
        198,
        247,
        20,
        60,
        136,
        174
      ]
    },
    {
      "name": "paused",
      "discriminator": [
        172,
        248,
        5,
        253,
        49,
        255,
        255,
        232
      ]
    },
    {
      "name": "pauserUpdated",
      "discriminator": [
        62,
        247,
        212,
        132,
        107,
        86,
        165,
        111
      ]
    },
    {
      "name": "protocolInitialized",
      "discriminator": [
        173,
        122,
        168,
        254,
        9,
        118,
        76,
        132
      ]
    },
    {
      "name": "refunded",
      "discriminator": [
        35,
        103,
        149,
        246,
        196,
        123,
        221,
        99
      ]
    },
    {
      "name": "released",
      "discriminator": [
        232,
        229,
        255,
        136,
        101,
        189,
        15,
        220
      ]
    },
    {
      "name": "reserved",
      "discriminator": [
        113,
        14,
        94,
        126,
        13,
        203,
        14,
        65
      ]
    },
    {
      "name": "tokenConfigAuthorityUpdated",
      "discriminator": [
        189,
        162,
        90,
        251,
        122,
        237,
        44,
        6
      ]
    },
    {
      "name": "treasurerUpdated",
      "discriminator": [
        107,
        48,
        14,
        55,
        213,
        153,
        61,
        210
      ]
    },
    {
      "name": "unpaused",
      "discriminator": [
        156,
        150,
        47,
        174,
        120,
        216,
        93,
        117
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Not authorized: the signer, a supplied account, or the program's authority state is not what this instruction requires"
    },
    {
      "code": 6001,
      "name": "recipientAlreadySet",
      "msg": "Recipient has already been set"
    },
    {
      "code": 6002,
      "name": "quoteHashCannotBeEmpty",
      "msg": "Offchain quote hash cannot be empty"
    },
    {
      "code": 6003,
      "name": "recipientNotSet",
      "msg": "Recipient has not been set"
    },
    {
      "code": 6004,
      "name": "missingSignatureVerification",
      "msg": "Missing Ed25519 signature verification instruction"
    },
    {
      "code": 6005,
      "name": "invalidVerificationInstruction",
      "msg": "The preceding instruction is not a single-signature Ed25519 verification with in-instruction data"
    },
    {
      "code": 6006,
      "name": "invalidPublicKey",
      "msg": "The public key is unset or does not match the signer this check expects"
    },
    {
      "code": 6007,
      "name": "invalidMessage",
      "msg": "The signed message does not match the message this check expects"
    },
    {
      "code": 6008,
      "name": "invalidData",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6009,
      "name": "invalidAuthority",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6010,
      "name": "invalidCaller",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6011,
      "name": "expired",
      "msg": "The delegate expiration is in the past"
    },
    {
      "code": 6012,
      "name": "capacityExceeded",
      "msg": "The requested amount exceeds the delegate's remaining capacity"
    },
    {
      "code": 6013,
      "name": "invalidMint",
      "msg": "Invalid mint address"
    },
    {
      "code": 6014,
      "name": "deadlineExpired",
      "msg": "The authorization deadline has passed"
    },
    {
      "code": 6015,
      "name": "transferSizeExceeded",
      "msg": "The requested amount exceeds the delegate's per-transfer maximum"
    },
    {
      "code": 6016,
      "name": "invalidRevoker",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6017,
      "name": "amountMustBeGreaterThanZero",
      "msg": "The deposit amount must be greater than zero"
    },
    {
      "code": 6018,
      "name": "deadlineTooFarInFuture",
      "msg": "The authorization deadline is beyond the replay window"
    },
    {
      "code": 6019,
      "name": "futureTransaction",
      "msg": "The authorization is stamped in the future"
    },
    {
      "code": 6020,
      "name": "expiredTransaction",
      "msg": "The authorization is older than the replay window, so nonce reuse can no longer be detected"
    },
    {
      "code": 6021,
      "name": "invalidSlot",
      "msg": "The nonce maps to a slot outside the replay bitmap"
    },
    {
      "code": 6022,
      "name": "duplicateTransaction",
      "msg": "This nonce has already been used inside the replay window"
    },
    {
      "code": 6023,
      "name": "alreadyInitialized",
      "msg": "Protocol already initialized"
    },
    {
      "code": 6024,
      "name": "protocolPaused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6025,
      "name": "adminTransferNotReady",
      "msg": "Admin transfer not ready - delay not elapsed"
    },
    {
      "code": 6026,
      "name": "mintNotAllowed",
      "msg": "Mint not in allowlist"
    },
    {
      "code": 6027,
      "name": "transferFeeMintNotAllowed",
      "msg": "Transfer-fee mints are not allowed"
    },
    {
      "code": 6028,
      "name": "feePercentageTooHigh",
      "msg": "Fee percentage exceeds 100%"
    },
    {
      "code": 6029,
      "name": "minFeeGreaterThanMaxFee",
      "msg": "Minimum fee cannot exceed maximum fee"
    },
    {
      "code": 6030,
      "name": "maxFeeSetButPercentageZero",
      "msg": "Maximum fee requires non-zero percentage"
    },
    {
      "code": 6031,
      "name": "feeExceedsAmount",
      "msg": "Computed fee exceeds deposit amount"
    },
    {
      "code": 6032,
      "name": "nonExactTransfer",
      "msg": "Transfer amount mismatch - exact transfer required"
    },
    {
      "code": 6033,
      "name": "insufficientEscrowBalance",
      "msg": "Escrow balance insufficient for intended release amount"
    },
    {
      "code": 6034,
      "name": "depositRequestHashCannotBeEmpty",
      "msg": "The depositor-signed deposit-request commitment cannot be zero"
    },
    {
      "code": 6035,
      "name": "destinationEmpty",
      "msg": "The committed destination hash cannot be zero"
    },
    {
      "code": 6036,
      "name": "destinationTooLong",
      "msg": "Not raised by this program: the 256-byte destination limit is enforced off chain"
    },
    {
      "code": 6037,
      "name": "amountCannotBeZero",
      "msg": "The reserved source amount cannot be zero"
    },
    {
      "code": 6038,
      "name": "sourceAmountExceedsDeposit",
      "msg": "The reserved source amount exceeds the amount the depositor authorized"
    },
    {
      "code": 6039,
      "name": "minFeeNotRepresentable",
      "msg": "Minimum fee is not representable in this mint's decimals"
    },
    {
      "code": 6040,
      "name": "maxFeeNotRepresentable",
      "msg": "Maximum fee is not representable in this mint's decimals"
    },
    {
      "code": 6041,
      "name": "malformedSignatureData",
      "msg": "The signature verification instruction's offsets or lengths fall outside its data"
    },
    {
      "code": 6042,
      "name": "feeArithmeticFailed",
      "msg": "The fee could not be rescaled: the deposit amount was zero, or the arithmetic overflowed"
    },
    {
      "code": 6043,
      "name": "roleAccountNotSet",
      "msg": "A required role account was left unset"
    },
    {
      "code": 6044,
      "name": "depositHashMismatch",
      "msg": "The recomputed deposit hash does not match the one this deposit was created with"
    },
    {
      "code": 6045,
      "name": "delegateLimitsInvalid",
      "msg": "The delegate's capacity and per-transfer limits are zero or inconsistent"
    },
    {
      "code": 6046,
      "name": "inconsistentTimestamps",
      "msg": "The authorization's deadline is before its issued_at, or its replay horizon overflows"
    },
    {
      "code": 6047,
      "name": "timestampOverflow",
      "msg": "A timestamp calculation overflowed"
    },
    {
      "code": 6048,
      "name": "signatureMessageSizeInvalid",
      "msg": "The signed message is not 32 bytes"
    },
    {
      "code": 6049,
      "name": "invalidDepositorAta",
      "msg": "Depositor token account is not the depositor's associated token account"
    },
    {
      "code": 6050,
      "name": "permanentDelegateMintNotAllowed",
      "msg": "Mints with a permanent delegate are not allowed"
    },
    {
      "code": 6051,
      "name": "mintExtensionNotAllowed",
      "msg": "The mint carries a Token-2022 extension the escrow does not accept"
    },
    {
      "code": 6052,
      "name": "hookAccountSignerNotAllowed",
      "msg": "A transfer hook account other than the transfer authority is a signer"
    }
  ],
  "types": [
    {
      "name": "defaultAdminDelayUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldDelaySeconds",
            "type": "u32"
          },
          {
            "name": "newDelaySeconds",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "defaultAdminTransferBegun",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "currentAdmin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "acceptAfterTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "defaultAdminTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "delegateRenounced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "delegate",
            "type": "pubkey"
          },
          {
            "name": "delegateSigner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "delegateRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "delegate",
            "type": "pubkey"
          },
          {
            "name": "delegateSigner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "depositInfo",
      "docs": [
        "Per-deposit escrow record.",
        "",
        "v3 grew this struct 217 -> 249 bytes by adding `quote_hash`. There is intentionally NO `realloc`",
        "and NO migration instruction: the layout change is not in-place-migratable, so an in-place program",
        "upgrade would leave existing 217-byte deposits undeserializable. v3 ships as a fresh redeploy with",
        "all in-flight deposits drained to a terminal state first, so there are no legacy accounts to",
        "migrate. See `docs/operations/deployment.md`, which owns the drain, redeploy and re-init",
        "sequence."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reserver",
            "type": "pubkey"
          },
          {
            "name": "releaser",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "depositHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositRequestHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "destinationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "feeAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "reserver",
            "type": "pubkey"
          },
          {
            "name": "releaser",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "issuedAt",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "escrowDelegate",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "delegateSigner",
            "type": "pubkey"
          },
          {
            "name": "maxTransferSize",
            "type": "u64"
          },
          {
            "name": "remainingCapacity",
            "type": "u64"
          },
          {
            "name": "expiration",
            "type": "u64"
          },
          {
            "name": "allowedMint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintAllowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintDisallowed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintFeeConfig",
      "docs": [
        "Per-mint fee configuration and allowlist entry",
        "Seeds: [\"mint_fee_config\", mint_pubkey]",
        "Existence of this PDA = mint is allowlisted"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "The mint this config applies to"
            ],
            "type": "pubkey"
          },
          {
            "name": "feePercentage6",
            "docs": [
              "Fee percentage scaled by 1e6 (1_000_000 = 1%, max 100_000_000 = 100%)"
            ],
            "type": "u64"
          },
          {
            "name": "minFee6",
            "docs": [
              "Minimum fee in 6-decimal normalized units"
            ],
            "type": "u64"
          },
          {
            "name": "maxFee6",
            "docs": [
              "Maximum fee in 6-decimal normalized units (0 = disabled)"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "mintFeesCleared",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintFeesUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feePercentage6",
            "type": "u64"
          },
          {
            "name": "minFee6",
            "type": "u64"
          },
          {
            "name": "maxFee6",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "paused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pauserUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldPauser",
            "type": "pubkey"
          },
          {
            "name": "newPauser",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "docs": [
        "Global protocol configuration PDA",
        "Seeds: [\"protocol_config\"]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "defaultAdmin",
            "docs": [
              "The default admin with full role management authority"
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenConfigAuthority",
            "docs": [
              "Authority for mint allowlist and fee configuration"
            ],
            "type": "pubkey"
          },
          {
            "name": "treasurer",
            "docs": [
              "Fee recipient (treasury owner)"
            ],
            "type": "pubkey"
          },
          {
            "name": "pauser",
            "docs": [
              "Authority for pause/unpause operations"
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether protocol operations are paused"
            ],
            "type": "bool"
          },
          {
            "name": "clusterId",
            "docs": [
              "Cluster-specific domain separator for signed escrow messages"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "signatureDomainVersion",
            "docs": [
              "Version byte for the escrow signature message schema"
            ],
            "type": "u8"
          },
          {
            "name": "defaultAdminDelaySeconds",
            "docs": [
              "Delay in seconds for default admin transfer"
            ],
            "type": "u32"
          },
          {
            "name": "pendingDefaultAdmin",
            "docs": [
              "Pending new default admin (two-step transfer)"
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingDefaultAdminAcceptAfterTs",
            "docs": [
              "Timestamp after which pending admin can accept transfer"
            ],
            "type": {
              "option": "i64"
            }
          }
        ]
      }
    },
    {
      "name": "protocolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "defaultAdmin",
            "type": "pubkey"
          },
          {
            "name": "tokenConfigAuthority",
            "type": "pubkey"
          },
          {
            "name": "treasurer",
            "type": "pubkey"
          },
          {
            "name": "pauser",
            "type": "pubkey"
          },
          {
            "name": "clusterId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "signatureDomainVersion",
            "type": "u8"
          },
          {
            "name": "defaultAdminDelaySeconds",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "refunded",
      "docs": [
        "APPEND-ONLY — see the note on `Released`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "quoteHash",
            "docs": [
              "Appended, not inserted — see the note above."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "released",
      "docs": [
        "APPEND-ONLY. Anchor derives an event's discriminator from its NAME, not its layout, so a field",
        "inserted mid-struct keeps the same discriminator and every un-upgraded positional consumer goes",
        "on matching it and silently mis-decodes — reading `quote_hash` as `recipient` and the leading",
        "bytes of the real pubkey as an amount. Nothing reverts and nothing logs.",
        "",
        "New members therefore go at the END, where a stale reader simply stops before them. That is what",
        "`Reserved` above does, and what `Released`/`Refunded` do here. atum-core's live scanner",
        "(`core/block-scanner-orchestrator/plugins/solana/plugin.go`) is exactly such a positional reader:",
        "its `readBytes` errors only on underrun, so trailing bytes are ignored by construction.",
        "",
        "Renaming the event is the only safe way to make a layout change breaking, because that is the",
        "one thing that moves the discriminator."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "grossAmount",
            "type": "u64"
          },
          {
            "name": "intendedAmount",
            "type": "u64"
          },
          {
            "name": "surplusAmount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "netAmount",
            "type": "u64"
          },
          {
            "name": "quoteHash",
            "docs": [
              "Appended, not inserted — see the note above."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "replayBucket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bitmaps",
            "type": {
              "array": [
                {
                  "array": [
                    "u64",
                    4
                  ]
                },
                2
              ]
            }
          }
        ]
      }
    },
    {
      "name": "reserved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "sourceAmount",
            "docs": [
              "The amount the payer is actually charged, which reserve narrows",
              "`DepositInfo.amount` to. Emitted so an indexer can see the charge without replaying the",
              "reserve preimage, and so the ceiling-vs-charge gap is observable off-chain."
            ],
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "docs": [
              "Scaled from the deposit-time snapshot to `source_amount`, NOT recomputed from the live",
              "`MintFeeConfig`: the rate is frozen at deposit and only the amount it applies to narrows.",
              "`Reserve` carries neither the mint nor the fee config, so recomputation is not merely avoided",
              "here, it is structurally impossible. Supersedes the ceiling-based value the `Deposited` event",
              "carried. See `reserve` for why it is scaled, and for the min/max clamp that is deliberately",
              "not re-evaluated against the smaller amount."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenConfigAuthorityUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAuthority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "treasurerUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldTreasurer",
            "type": "pubkey"
          },
          {
            "name": "newTreasurer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "unpaused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
