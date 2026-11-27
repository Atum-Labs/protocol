/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fulfillment_proxy.json`.
 */
export type FulfillmentProxy = {
  "address": "77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe",
  "metadata": {
    "name": "fulfillmentProxy",
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
      "name": "addAuthorizedSettler",
      "discriminator": [
        85,
        52,
        136,
        75,
        241,
        13,
        131,
        237
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
          "name": "settler",
          "type": "pubkey"
        }
      ]
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
      "name": "fulfill",
      "discriminator": [
        143,
        2,
        52,
        206,
        174,
        164,
        247,
        72
      ],
      "accounts": [
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
          "name": "settler",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "fromAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "settler"
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
          "name": "toAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "to"
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
          "name": "to"
        },
        {
          "name": "mint"
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
          "name": "quoteHash",
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
        }
      ]
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
            "The fulfillment proxy program executable account."
          ],
          "address": "77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe"
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
          "name": "pauser",
          "type": "pubkey"
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
      "name": "removeAuthorizedSettler",
      "discriminator": [
        173,
        53,
        3,
        244,
        118,
        124,
        44,
        255
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
          "name": "settler",
          "type": "pubkey"
        }
      ]
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
      "name": "setEnforceSettlerAllowlist",
      "discriminator": [
        81,
        120,
        174,
        150,
        19,
        99,
        198,
        53
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
          "name": "enforced",
          "type": "bool"
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
      "name": "strictFulfill",
      "discriminator": [
        112,
        14,
        62,
        129,
        191,
        171,
        85,
        237
      ],
      "accounts": [
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
          "name": "settler",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "replayBucket",
          "writable": true
        },
        {
          "name": "strictFulfillment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  105,
                  99,
                  116,
                  95,
                  102,
                  117,
                  108,
                  102,
                  105,
                  108,
                  108,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "quoteHash"
              },
              {
                "kind": "account",
                "path": "settler"
              }
            ]
          }
        },
        {
          "name": "fromAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "settler"
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
          "name": "toAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "to"
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
          "name": "to"
        },
        {
          "name": "mint"
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
          "name": "legacyStrictFulfillment",
          "docs": [
            "`[b\"strict_fulfilled\", quote_hash]`. Read-only and only its emptiness is checked; the seeds",
            "constraint pins the address. Drop it in a later upgrade once no old marker matters."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  105,
                  99,
                  116,
                  95,
                  102,
                  117,
                  108,
                  102,
                  105,
                  108,
                  108,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "quoteHash"
              }
            ]
          }
        }
      ],
      "args": [
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
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "issuedAt",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "u64"
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
    },
    {
      "name": "strictFulfillment",
      "discriminator": [
        214,
        43,
        192,
        217,
        181,
        240,
        225,
        124
      ]
    }
  ],
  "events": [
    {
      "name": "authorizedSettlerAdded",
      "discriminator": [
        230,
        36,
        134,
        54,
        108,
        241,
        112,
        238
      ]
    },
    {
      "name": "authorizedSettlerRemoved",
      "discriminator": [
        197,
        242,
        193,
        0,
        158,
        88,
        36,
        76
      ]
    },
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
      "name": "fulfilled",
      "discriminator": [
        210,
        174,
        131,
        213,
        40,
        182,
        83,
        110
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
      "name": "settlerAllowlistEnforcementSet",
      "discriminator": [
        233,
        255,
        127,
        99,
        127,
        127,
        43,
        203
      ]
    },
    {
      "name": "strictFulfilled",
      "discriminator": [
        27,
        163,
        12,
        20,
        64,
        1,
        100,
        160
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
      "msg": "Caller is not authorized for this operation"
    },
    {
      "code": 6001,
      "name": "alreadyInitialized",
      "msg": "Protocol already initialized"
    },
    {
      "code": 6002,
      "name": "protocolPaused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6003,
      "name": "adminTransferNotReady",
      "msg": "Admin transfer not ready - delay not elapsed"
    },
    {
      "code": 6004,
      "name": "deadlineExpired",
      "msg": "The authorization deadline has passed"
    },
    {
      "code": 6005,
      "name": "deadlineTooFarInFuture",
      "msg": "The authorization deadline is beyond the replay window"
    },
    {
      "code": 6006,
      "name": "futureTransaction",
      "msg": "The authorization is stamped in the future"
    },
    {
      "code": 6007,
      "name": "expiredTransaction",
      "msg": "The authorization is older than the replay window, so nonce reuse can no longer be detected"
    },
    {
      "code": 6008,
      "name": "invalidSlot",
      "msg": "The nonce maps to a slot outside the replay bitmap"
    },
    {
      "code": 6009,
      "name": "invalidData",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6010,
      "name": "alreadyFulfilled",
      "msg": "This quote has already been strictly fulfilled"
    },
    {
      "code": 6011,
      "name": "capacityExceeded",
      "msg": "Reserved, not raised"
    },
    {
      "code": 6012,
      "name": "unauthorizedSettler",
      "msg": "Settler is not authorized to strictly fulfill"
    },
    {
      "code": 6013,
      "name": "quoteHashCannotBeEmpty",
      "msg": "Quote hash must not be empty"
    },
    {
      "code": 6014,
      "name": "amountCannotBeZero",
      "msg": "The fulfillment amount must be greater than zero"
    },
    {
      "code": 6015,
      "name": "inconsistentTimestamps",
      "msg": "The authorization's deadline is before its issued_at, or its replay horizon overflows"
    },
    {
      "code": 6016,
      "name": "authorizedSettlerListFull",
      "msg": "The authorized settler list is full"
    },
    {
      "code": 6017,
      "name": "timestampOverflow",
      "msg": "A timestamp calculation overflowed"
    },
    {
      "code": 6018,
      "name": "nonExactTransfer",
      "msg": "Recipient did not receive the exact fulfillment amount"
    }
  ],
  "types": [
    {
      "name": "authorizedSettlerAdded",
      "docs": [
        "Emitted when the admin adds a settler to the `strict_fulfill` allowlist."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "settler",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorizedSettlerRemoved",
      "docs": [
        "Emitted when the admin removes a settler from the `strict_fulfill` allowlist."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "settler",
            "type": "pubkey"
          }
        ]
      }
    },
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
      "name": "fulfilled",
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "amount",
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
        "Global protocol configuration PDA.",
        "Seeds: [\"protocol_config\"]",
        "",
        "v3 grew this struct ~119 -> 636 bytes by adding `enforce_settler_allowlist` and the pre-sized",
        "`authorized_settlers` vec. `init_if_needed` only allocates space for a brand-new account and never",
        "resizes an existing one, so an in-place program upgrade would leave the old config too small to",
        "deserialize (breaking every instruction that loads it). There is intentionally NO `realloc` and NO",
        "migration instruction: v3 ships as a fresh redeploy that re-runs `initialize_protocol` on a fresh",
        "PDA (created at the full 636-byte size). See `docs/operations/deployment.md` for the redeploy",
        "and re-initialization sequence."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "defaultAdmin",
            "docs": [
              "The default admin with full role management authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "pauser",
            "docs": [
              "Authority for pause/unpause operations."
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether protocol operations are paused."
            ],
            "type": "bool"
          },
          {
            "name": "defaultAdminDelaySeconds",
            "docs": [
              "Delay in seconds for default admin transfer."
            ],
            "type": "u32"
          },
          {
            "name": "pendingDefaultAdmin",
            "docs": [
              "Pending new default admin (two-step transfer)."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingDefaultAdminAcceptAfterTs",
            "docs": [
              "Timestamp after which pending admin can accept transfer."
            ],
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "enforceSettlerAllowlist",
            "docs": [
              "When true, `strict_fulfill` requires the settler to be in `authorized_settlers`.",
              "Ships false (dormant) so a fresh redeploy behaves exactly like the prior program; the admin",
              "flips it on after the allowlist is provisioned, and can flip it back off (instant rollback)."
            ],
            "type": "bool"
          },
          {
            "name": "authorizedSettlers",
            "docs": [
              "Settlers authorized to call `strict_fulfill` when enforcement is on. Bounded by",
              "MAX_AUTHORIZED_SETTLERS; the account is pre-sized for the maximum at init so no realloc is",
              "needed as entries are added/removed."
            ],
            "type": {
              "vec": "pubkey"
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
            "name": "pauser",
            "type": "pubkey"
          },
          {
            "name": "defaultAdminDelaySeconds",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "replayBucket",
      "docs": [
        "Replay protection bucket for a specific settler."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bitmaps",
            "docs": [
              "Two parity bitmaps; each parity has 256 bits (4x u64 words).",
              "Word 3 packs control metadata:",
              "- bit 63: initialization sentinel",
              "- bits 43..62: 20-bit epoch"
            ],
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
      "name": "settlerAllowlistEnforcementSet",
      "docs": [
        "Emitted when the admin toggles settler-allowlist enforcement on `strict_fulfill`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "enforced",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "strictFulfilled",
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "amount",
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
      "name": "strictFulfillment",
      "docs": [
        "One-time marker that a given settler has strictly fulfilled a given `quote_hash`. Seeded by the",
        "quote hash and the settler, so a strict fulfillment is unique per (quote, settler) across any",
        "nonce. The quote hash is public before the destination fulfill, so a marker seeded by the quote",
        "hash alone could be set by any account to block the assigned settler; with the settler in the",
        "seeds, another account only marks its own slot. Never closed. Markers written before the",
        "settler joined the seeds sit at [\"strict_fulfilled\", quote_hash]; `strict_fulfill` refuses a quote",
        "whose address there is not empty.",
        "Seeds: [\"strict_fulfilled\", quote_hash, settler]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fulfilled",
            "type": "bool"
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
