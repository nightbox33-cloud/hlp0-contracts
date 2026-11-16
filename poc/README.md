# HLP0 audit PoC — local EVM, no RPC / no fork

Two code sets are exercised:

| path | what it is |
|---|---|
| `../src/` | the repo head `hlp0to/hlp0-contracts@d29208a` ("v1") |
| `prod/src/` | the **verified production implementation** `0xD8Aa810b9C23c7a80E1D5e67Cf534DCF956B1e5D` behind proxy `0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81` (Sourcify full match, solc 0.8.28, cancun) |

`prod/src/HLP0.sol` was transcribed from the verified source; `IHLPUSDC.sol`,
`IHLPSHARES.sol`, `HLPUSDC.sol`, `HLPSHARES.sol` are byte-identical to the repo
and to Sourcify for `0x91Bd968a…` / `0x7ca13681…`. `interfaces/ISwapRouter.sol`
and `interfaces/IHyperliquidBridge.sol` are reconstructed declarations (signature
only) and carry no logic under test.

## Reproduce

```bash
cd poc/deps && npm install          # pinned OZ 5.3.0 + LayerZero versions from package.json
cd ../.. && npm install             # solc / ethereumjs harness deps

# repo head (v1) — needs the real code at the USDC constant address
POC_EXTRA_DIRS=poc/contracts node poc/compile.js
node poc/scenario.js

# production implementation (v2)
POC_SRC_ONLY_PROD=1 POC_EXTRA_DIRS=poc/contracts node poc/compile.js
node poc/prod_scenario.js
node poc/prod_privileged.js

node poc/slot.js                    # ERC-7201 namespace check
```

LayerZero's EndpointV2 and the Arbitrum USDC token are replaced by local stubs
installed at their **real addresses** (`0x1a44…728c`, `0xaf88…5831`) so the
production constants resolve unchanged. Nothing is forked.
