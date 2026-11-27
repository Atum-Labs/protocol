# Shasta Deployment Resource Usage

Verified on-chain against Shasta testnet on 2026-04-16.


| # | Operation                  | TxID                                                               | Energy    | Bandwidth |
|---|----------------------------|--------------------------------------------------------------------|----------:|----------:|
| 1 | Deploy Migrations          | `1af08def50c4c3feb72c6a8e58b012d83c20d9800050bc1e60a7b0996e7ffeee` |   103,820 |       874 |
| 2 | Migrations.setCompleted    | `dc9b5f0bcf0d3d2f732b0d9ba7069507615d8b3f1c8b9c6283b2da52be49d7fa` |    20,251 |       314 |
| 3 | Deploy Escrow              | `3128aa7b5872e90c67a146c3dee852159e7cec64bd40660da935f4d18b9d24a5` | 4,239,424 |    27,565 |
| 4 | Deploy FulfillmentProxy    | `798be11faaebf7a2ce3e857b4a7f3e01e7b8d73cbbacb9cde33ab4532f5cfd0d` | 1,478,767 |    10,270 |
| 5 | Migrations.setCompleted    | `172deee9bb103fbac024a042e5688a6066db489e196c649493be1e50beea2157` |     5,251 |       314 |
| 6 | grantRole (Escrow PAUSER)  | `87781b26a5fadf6114ea0bfcdf7b06f14b9e82c94ce26280dbb75d54c682cfab` |    23,072 |       345 |
| 7 | grantRole (Escrow TREASURER) | `c46d24498e360532c19bfe4c06c9c25c8b577c0fe287f5b3acb5367d4b407949` |    23,072 |       345 |
| 8 | grantRole (Escrow TOKEN_CONFIG) | `2f64a70c02c0548fd76274c6c49cca9fbf3183b6c6718799c834fc3b32c185c5` |    23,072 |       345 |
| 9 | grantRole (FP PAUSER)      | `5366e7503ee183a93dff5463980c16f191ccb14a3bdf3a14d347dff4b566b351` |    22,962 |       345 |
| 10 | allowTokenAndSetFeeConfig | `36bf02b73cd24ea2f90db541e4998070512d56968cbf6ae39ee0c731db42e47e` |    82,626 |       443 |
| 11 | setTokenFeeConfig         | `17f65d4a9f3b7de6999025c4804554b3a86291f207524161a4121d8dfebf60fd` |    18,981 |       411 |
|   | **TOTAL**                  |                                                                    | **6,041,298** | **41,571** |

