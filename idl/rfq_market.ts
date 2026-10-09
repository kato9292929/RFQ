/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/rfq_market.json`.
 */
export type RfqMarket = {
  "address": "7XpxowqbuaEbQ3VkuQemFi7B3aMuat7eKtp5kydGvsVp",
  "metadata": {
    "name": "rfqMarket",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Buyer-initiated RFQ market for agents (Solana devnet)"
  },
  "instructions": [
    {
      "name": "award",
      "discriminator": [
        180,
        74,
        165,
        67,
        179,
        135,
        27,
        202
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true,
          "relations": [
            "rfq"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
          "name": "rfq",
          "writable": true
        },
        {
          "name": "quote",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  111,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "rfq"
              },
              {
                "kind": "account",
                "path": "quote.seller",
                "account": "quote"
              }
            ]
          }
        },
        {
          "name": "buyerUsdc",
          "writable": true
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "cancelRfq",
      "discriminator": [
        65,
        47,
        228,
        229,
        50,
        93,
        212,
        236
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true,
          "relations": [
            "rfq"
          ]
        },
        {
          "name": "rfq",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
          "name": "usdcMint"
        },
        {
          "name": "treasury"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "usdcMint",
          "type": "pubkey"
        },
        {
          "name": "treasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "postRfq",
      "discriminator": [
        214,
        57,
        240,
        30,
        68,
        131,
        117,
        222
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "rfq",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  102,
                  113
                ]
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "specHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "specUri",
          "type": "string"
        },
        {
          "name": "maxPrice",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "recordFulfillment",
      "discriminator": [
        30,
        160,
        36,
        242,
        114,
        71,
        120,
        2
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true,
          "relations": [
            "rfq"
          ]
        },
        {
          "name": "rfq",
          "writable": true
        },
        {
          "name": "quote"
        },
        {
          "name": "fulfillment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  108,
                  102,
                  105,
                  108,
                  108,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "rfq"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "paymentSig",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "responseHash",
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
      "name": "submitQuote",
      "discriminator": [
        230,
        121,
        122,
        202,
        228,
        6,
        91,
        181
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "rfq"
        },
        {
          "name": "quote",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  111,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "rfq"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "endpointHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "endpointUri",
          "type": "string"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "fulfillment",
      "discriminator": [
        164,
        71,
        75,
        155,
        33,
        200,
        198,
        185
      ]
    },
    {
      "name": "quote",
      "discriminator": [
        167,
        202,
        20,
        198,
        228,
        66,
        105,
        208
      ]
    },
    {
      "name": "rfq",
      "discriminator": [
        106,
        19,
        109,
        78,
        169,
        13,
        234,
        58
      ]
    }
  ],
  "events": [
    {
      "name": "quoteSubmitted",
      "discriminator": [
        207,
        98,
        251,
        106,
        249,
        124,
        126,
        40
      ]
    },
    {
      "name": "rfqAwarded",
      "discriminator": [
        220,
        145,
        18,
        214,
        44,
        66,
        37,
        130
      ]
    },
    {
      "name": "rfqFulfilled",
      "discriminator": [
        144,
        250,
        63,
        82,
        82,
        28,
        41,
        18
      ]
    },
    {
      "name": "rfqPosted",
      "discriminator": [
        252,
        110,
        236,
        253,
        94,
        71,
        133,
        243
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidFee",
      "msg": "fee_bps must be <= 10000"
    },
    {
      "code": 6001,
      "name": "mintMismatch",
      "msg": "usdc_mint argument does not match account"
    },
    {
      "code": 6002,
      "name": "treasuryMismatch",
      "msg": "treasury does not match config"
    },
    {
      "code": 6003,
      "name": "deadlineInPast",
      "msg": "deadline must be in the future"
    },
    {
      "code": 6004,
      "name": "uriTooLong",
      "msg": "URI exceeds 200 bytes"
    },
    {
      "code": 6005,
      "name": "zeroPrice",
      "msg": "price must be > 0"
    },
    {
      "code": 6006,
      "name": "rfqNotOpen",
      "msg": "RFQ is not open"
    },
    {
      "code": 6007,
      "name": "deadlinePassed",
      "msg": "RFQ deadline has passed"
    },
    {
      "code": 6008,
      "name": "priceAboveMax",
      "msg": "quote price exceeds RFQ max_price"
    },
    {
      "code": 6009,
      "name": "quoteExpired",
      "msg": "quote has expired"
    },
    {
      "code": 6010,
      "name": "notBuyer",
      "msg": "signer is not the RFQ buyer"
    },
    {
      "code": 6011,
      "name": "quoteMismatch",
      "msg": "quote does not belong to this RFQ / award"
    },
    {
      "code": 6012,
      "name": "rfqNotAwarded",
      "msg": "RFQ has not been awarded"
    },
    {
      "code": 6013,
      "name": "mathOverflow",
      "msg": "math overflow"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "fulfillment",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "quote",
            "type": "pubkey"
          },
          {
            "name": "paymentSig",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "responseHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fulfilledAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "quote",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "endpointHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "endpointUri",
            "type": "string"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "quoteSubmitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "quote",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "rfq",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "specUri",
            "type": "string"
          },
          {
            "name": "maxPrice",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "awardedQuote",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rfqAwarded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "quote",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rfqFulfilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "quote",
            "type": "pubkey"
          },
          {
            "name": "paymentSig",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "responseHash",
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
      "name": "rfqPosted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rfq",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxPrice",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
