# Auditoría ofensiva HLP0 — hlp0to / hlp0.to (Arbitrum + despliegues OFT)

**Veredicto: `no crítico permissionless en código`.**
No encontré una ruta ejecutable por un atacante **sin rol** que termine con más valor del que puso a costa de fondos de terceros.
Pero la auditoría sí destapó un hallazgo de primer orden: **el código del repositorio no es el código en producción**, y el código que sí está en producción concentra la custodia de terceros en roles EOA sin multisig ni timelock, con una cola de redenciones ya insolvente.

---

## 1. Requisito previo: mapeo de la fundación (sin RPC)

### 1.1 Orgs / espacios de la fundación

| espacio | estado |
|---|---|
| GitHub `hlp0to` (org "HLP0", blog `https://hlp0.to`, X `@hlp0_to`) | **1 repo público**: `hlp0to/hlp0-contracts` |
| miembros públicos de la org | `[]` (vacío) |
| otros repos de la fundación | **no existen** (búsqueda `hlp0`, `hlp0.to`, `HLPUSDC in:file`: sólo `hlp0to/*` + ruido de terceros) |
| repo del workspace `nightbox33-cloud/hlp0-contracts` | **fork** de `hlp0to/hlp0-contracts` (cuenta con 334 repos, **100 % forks**) |

### 1.2 Repos clonados / commits exactos

| repo | commit | ramas/tags | notas |
|---|---|---|---|
| `hlp0to/hlp0-contracts` (vía fork `nightbox33-cloud`) | `d29208a9ac471a76506b1a2d480c83d80c07fd48` ("fix: folders", 2025-06-21) | 1 rama `main`, **0 tags** | 3 commits totales (`6ef21d9` initial, `02462f2` push contracts, `d29208a` fix folders), 18 archivos, 1856 inserciones, autor único `keccakdog` |

### 1.3 Configuración de despliegue **dentro** del repo

No existe `deployments/`, `broadcast/`, `scripts/`, `config/`, `genesis.json`, `Anchor.toml`, `Move.toml`, **ni carpeta de tests** (`npm test` → `Error: no test specified`).
El repo no contiene ningún parámetro de producción: sólo dos direcciones hardcodeadas (`USDC` y, indirectamente, el endpoint LZ por constructor) y las constantes de `src/HLP0.sol`.

### 1.4 Despliegue real (reconstruido desde código verificado + exploradores web, sin RPC)

| componente | dirección (Arbitrum One) | fuente |
|---|---|---|
| Proxy EIP-1967 "HLP0: hlp0 Token" | `0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81` | arbiscan; coincide con hlp0.to (`0x3d75..6c81`) |
| **Implementación activa** | `0xD8Aa810b9C23c7a80E1D5e67Cf534DCF956B1e5D` | arbiscan (`#code`), Sourcify **full match**, solc 0.8.28, optimizer on, `cancun` |
| Upgrade del proxy | 2025-08-27 15:24:57, bloque `372876050`, tx `0x99544eba…b03294` | arbiscan "1 proxy using this implementation" |
| Deployer | `0xD73E844755b3d09DB80a277adCa00F9B4B2833e5` | "ContractCreator" |
| HLPUSDC | `0x91Bd968a8bd27C08B9Fc7173d0F475411a6214C5` | Sourcify full match (**byte-idéntico al repo**) |
| HLPSHARES | `0x7ca13681dfb071de2c6461adb7a29a950743afdf` | Sourcify full match (**byte-idéntico al repo**) |
| HLPAMO | `0x42aCE8104bcEbfCD56E4fF0eC72E97E38E5d2727` | Sourcify full match |
| LayerZero EndpointV2 | `0x1a44076050125825900e736c501f859c50fE728c` | constructor args del impl |
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | constante en código |
| Hyperliquid bridge / receiver | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` / `0x97885bC45B300D405E61B397B8f37379B597D809` | constantes en código v2 |
| Router AMO / pool | `0xAA23611badAFB62D37E7295A682D21960ac85A90` (fee 100 = 0.01 %) / pool Ramses `0xb1cc419cb5d442dd68d54ed9646e4809f24553b8` | `HLPAMO.sol` + geckoterminal |
| Despliegues OFT multi-chain | misma dirección `0x3D75…6C81` reportada en Sonic, HyperEVM, Avalanche | coinbase/holder.io/kriptomat (terceros; **no verificado** bytecode por cadena) |

### 1.5 Parámetros de producción (código verificado + estado on-chain leído del explorador)

| parámetro | valor |
|---|---|
| `ORACLE_STALE_INTERVAL` | **7 days** (repo: `30 minutes`) |
| `MAX_DEVIATION_FROM_RATIO` | `0.002 * 1e6` = 2000 (0,2 % por llamada) |
| `MIN_REDEEM_AMOUNT` / `MIN_DEPOSIT_AMOUNT` | `100e6` / `100e6` (depósito inalcanzable: cerrado) |
| `syncBacking` floor | `totalAssets() > 3_000_000e6`, deriva de ratio ≤ 1 wei |
| `deposit()` / `mint()` | `revert("PROTOCOL SUNSETTING - DEPOSITS CLOSED")` |
| **totalAssets()** (HLPUSDC) | `387 907.012732` |
| **totalSupply()** (HLPSHARES) | `378 245.746236` |
| ratio | `1.025542` |
| **USDC real en el vault** | **`3.268286`** |
| **pendingUsdcDebt** | **`323 855.093307`** |
| HLP0 en pool Ramses | 1,16–1,27 M HLP0 vs 72 873 USDC (precio $1.0082) |

> El vault **debe** 323 855 USDC a redimidores y **tiene** 3,268286 USDC. Es un estado ya consumado (sunsetting), no un bug que el atacante pueda provocar.

---

## 2. Hallazgo principal: el repo no es el código de producción

| | repo `d29208a` ("v1") | producción `0xD8Aa…1e5D` ("v2") |
|---|---|---|
| `ORACLE_STALE_INTERVAL` | 30 min | **7 days** |
| `nonReentrant` en `requestRedeem` / `processRequest` / `deposit` / `mint` | sí | **eliminado** |
| modelo de pago de redención | pull: `safeTransferFrom(USDC, requestProcessor, requestor, amt)` | **push desde el propio vault**: `USDC.transfer(requestor, amt)` + `pendingUsdcDebt` |
| `deposit` / `mint` | activos (mín. 100 USDC) | **revierten (sunsetting)** |
| `amoRedeem`, `processRequestsBatch`, `syncBacking`, `bridgeBackingWithPermit`, `_processRequest` | **no existen** | existen |
| constante `HLP_AMO`, `HYPERLIQUID_BRIDGE`, `HYPERLIQUID_RECEIVER`, `MAX_DEVIATION_FROM_RATIO` | no | sí |
| `actualTokenSupply()` | sí | renombrado `actualTotalSupply()` |
| circuit breakers en `rebase`/`debase` | sólo `ratio >= 1e6` en debase | + tope por llamada 0,2 % |

Consecuencias directas:
1. **Una auditoría sobre el repo head no cubre el binario en producción.** Toda conclusión de esta sección 2 se obtuvo del fuente verificado, no del repo.
2. El repo **no tiene tests, ni scripts, ni artefactos de despliegue**, por lo que no fue posible reconstruir el despliegue "desde el propio código" como pide el requisito: hubo que usar el fuente verificado en el explorador + Sourcify.
3. El propio contrato en producción se autodeclara en sunsetting y **cerró los depósitos**, lo que elimina de facto la superficie de mayor riesgo (mint de shares por depósito).

---

## 3. Rutas críticas verificadas y resultado (PoC local, sin RPC ni fork)

Metodología del PoC: se compilan los fuentes **sin modificar** (`src/` y `poc/prod/src/`) con solc 0.8.26 contra las dependencias que declara `package.json` (OZ 5.3.0, LayerZero oft-evm 3.1.4 / oft-evm-upgradeable 3.1.0 / oapp-evm 0.3.2 / lz-evm-protocol-v2 3.0.99), se instala USDC y EndpointV2 en **sus direcciones reales** y se ejecutan **transacciones firmadas reales** en `@ethereumjs/vm`. El proxy se coloca en `0x3D75…6C81` y la implementación se activa en su slot ERC-1967.

### 3.1 Hipótesis descartada #1 — "requestRedeem quema las HLPSHARES de todo el vault"

`src/HLP0.sol:158` llama `$.HLPSHARES.burn(_amountOfHLP)` sin cota ni allowance, y `HLPSHARES.burn` quema el saldo **del minter** (el vault). Parecía un drain.

**Refutado por ejecución** — `_burn(msg.sender, _amountOfHLP)` (ERC20, línea 156) revierte antes:

```
== step 1: attacker deposits the 100 USDC minimum ==
attacker HLP0 shares        = 100
vault HLPSHARES balance     = 2,000,100
== step 2: requestRedeem(vault's whole HLPSHARES balance) ==
_amountOfHLP being burnt    = 2,000,100 (attacker only owns 100)
requestRedeem              -> REVERT: 0xe450d38c000000000000000000000000<attacker>
```
`0xe450d38c` = `ERC20InsufficientBalance(address,uint256,uint256)`. El atacante no puede quemar shares ajenas, y `attacker_allowance_to_vault = 0` (el error no es de allowance).

### 3.2 Superficie permissionless del binario en producción: **toda bloqueada**

`node poc/prod_scenario.js` (estado de producción sembrado con los valores reales):

```
== PATH A: permissionless payout attempts (all must fail) ==
 blocked  processRequest(0)              NOT REQUEST PROCESSOR
 blocked  processRequestsBatch([0])      NOT REQUEST PROCESSOR
 blocked  startBridgingBacking           NOT REQUEST PROCESSOR
 blocked  amoRedeem(0,1)                 NOT AMO
 blocked  bridgeBackingWithPermit        NOT REQUEST PROCESSOR
 blocked  syncBacking(1)                 NOT ORACLE PROVIDER
 blocked  rebase(1e18)                   NOT ORACLE PROVIDER
 blocked  debase(1e6)                    NOT ORACLE PROVIDER
 blocked  setGovernance(attacker)        NOT GOVERNANCE
 blocked  setOracleProvider(attacker)    NOT GOVERNANCE
 blocked  setRequestProcessor(attacker)  NOT GOVERNANCE
 blocked  setPeer(1,attacker)            OwnableUnauthorizedAccount
 blocked  deposit(100e6)                 PROTOCOL SUNSETTING - DEPOSITS CLOSED
 blocked  mint(100e6)                    PROTOCOL SUNSETTING - DEPOSITS CLOSED
 blocked  withdraw / redeem              USE REQUEST REDEEM

== PATH B: share inflation / unauthorised burn ==
 blocked  requestRedeem(1e18)            ERC20InsufficientBalance
 blocked  requestRedeem(totalSupply)     ERC20InsufficientBalance
 blocked  requestRedeem(holderShares)    ERC20InsufficientBalance
```

Único entrypoint que mueve valor y es permissionless: `requestRedeem` — y sólo quema **HLP0 propio**, nunca ajeno. No hay camino `Y > X`.

### 3.3 Otras hipótesis verificadas y descartadas

- **Colisión de namespace ERC-7201.** `poc/slot.js`: el slot `0x632e63c3…79b00` **sí** es `keccak256(abi.encode(uint256(keccak256("hlp0.storage.v1"))-1)) & ~0xff`, y **no** colisiona con `oz.erc20.storage`, `oz.access.ownable`, `oz.utils.reentrancyguard` ni con los 4 namespaces `layerzerov2.storage.*` que hereda. Sin solapamiento ⇒ sin corrupción de storage.
- **`totalSupply()` override como vector de ratio por bridging.** `totalSupply()` devuelve el saldo HLPSHARES del vault y `actualTotalSupply()` el supply de HLP0; el path OFT (`OFTCoreUpgradeable._debit`/`_credit`) sólo quema/miñe HLP0 y **no** lee `totalSupply()` (verificado en el fuente de la dependencia) ⇒ cruzar el puente no altera `totalAssets()/totalSupply()`.
- **Reentrancy.** v2 quitó `nonReentrant`, pero `requestRedeem` no hace llamadas externas controlables (sólo `_burn` + `HLPSHARES.burn` + `HLPUSDC.burn`, todos minter-gated y sin hooks) y `_processRequest` usa `USDC.transfer` (ERC-20 sin callbacks). Sin ruta reentrante permissionless.
- **Inflación ERC-4626 / donación.** `HLPUSDC`/`HLPSHARES` sólo los miñea/quema el vault; donar HLPUSDC al vault sube el ratio a favor de los tenedores (pérdida neta para el donante); `deposit/mint` están cerrados.
- **`L1Read.sol`** es un wrapper de precompilados sin estado ni fondos: fuera de la superficie de custodia.

---

## 4. Hallazgos de impacto crítico **no permissionless** (no clasificables como crítico según los 4 criterios)

Los reporto porque mueven fondos de terceros si el rol está comprometido, con el PoC que lo demuestra, pero **no cumplen el criterio 2** (requieren rol) y por tanto no se etiquetan como crítico explotable.

### H1 — `requestProcessor` es una única EOA y puede barrer el 100 % del USDC del vault
`poc/prod/src/HLP0.sol:243` (`startBridgingBacking`) transfiere **todo** el balance al `$.requestProcessor`; `:249` (`bridgeBackingWithPermit`) transfiere `usdcAmount` a esa misma EOA y la usa como `user` del depósito a Hyperliquid (el USDC queda acreditado a la EOA, no al vault); `processRequest(s)` decide el **orden** de pago de la cola.

```
== (C) requestProcessor can sweep the contract USDC ==
 vault 3.268286 -> 0 | requestProcessor 3.268286
```
Condición de configuración: `requestProcessor` = EOA (no multisig/timelock en código; `setRequestProcessor` es `OnlyGovernance`). Verificar el tipo de cuenta on-chain queda fuera del alcance sin RPC.

### H2 — Cola de redenciones insolvente y FCFS sobre el claim de terceros
`requestRedeem` (v2 línea 171) quema `HLP0` + `HLPSHARES` + `HLPUSDC` del solicitante y sólo **registra** la deuda (`pendingUsdcDebt += expectedOutput`, línea 184). No aparta USDC. `_processRequest` exige `USDC.balanceOf(this) >= requestAmount` (línea 210) y si no, revierte.

```
== (B) redemption queue (real USDC balance ~= 0) ==
 holderA requestRedeem -> accepted (HLP0+shares+backing burnt)
 holderB requestRedeem -> accepted (HLP0+shares+backing burnt)
 pendingUsdcDebt = 709,870.877308 | USDC in vault = 3.268286
 processRequest(A) -> REVERT: INSUFFICIENT USDC BALANCE
 processRequest(B) -> REVERT: INSUFFICIENT USDC BALANCE
```
Impacto: el tenedor **pierde su HLP0 y su claim contable** y queda con una deuda impagable; quién cobra es puramente FCFS. **No genera ganancia al atacante** (tendría que ser tenedor y su "ganancia" es su propio claim), por eso no es crítico explotable.

### H3 — `debase()`: tope por llamada ≠ tope acumulado
`poc/prod/src/HLP0.sol:300`: cada llamada exige `oldRatio - newRatio <= 2000` (0,2 %) y `newRatio >= 1e6`, pero **no hay límite acumulado** y el oracle refresca su propio `lastOracleUpdate` (saltándose `StaleDataCheck`). Quema HLPUSDC de los tenedores en pasos sucesivos.

```
== (A) debase(): per-call 0.2% cap is not a cumulative cap ==
  ok  burn#1 -> ratio 1.024542 totalAssets 387,528.766986
  ok  burn#2 -> ratio 1.023542 totalAssets 387,150.521240
  ok  burn#3 -> ratio 1.022542 totalAssets 386,772.275494
  ok  burn#4 -> ratio 1.021542 totalAssets 386,394.029748
  ok  burn#5 -> ratio 1.020542 totalAssets 386,015.784002
```
Además `syncBacking` (línea 359) reescribe `HLPUSDC` **y** `HLPSHARES` directamente (sólo acotado por "ratio ±1 wei" y floor de 3 M).

### H4 — Liveness: `pendingUsdcDebt -= requestAmount` puede panickear peticiones históricas
`poc/prod/src/HLP0.sol:212` resta sin comprobar. Si una `request` previa a la migración v1→v2 tiene `requestAmount` mayor que el `pendingUsdcDebt` registrado, `_processRequest` revierte con `Panic(0x11)` y esa redención queda **permanentemente impagable** (`processRequest`/`processRequestsBatch`). Condición: existencia de requests anteriores a la introducción del campo. No verificable sin el mapa de requests.

### H5 — Sobre-suscripción de claims: HLP0 en circulación ≫ HLPSHARES
El pool Ramses tiene 1,16–1,27 M HLP0 contra 72 873 USDC, mientras el vault sólo custodia **378 245.746236** HLPSHARES y **387 907.012732** HLPUSDC. El path OFT `_credit()` miñea HLP0 en destino **sin respaldo**; al volver a Arbitrum esos tokens compiten por las mismas HLPSHARES (vía `HLPSHARES.burn(_amountOfHLP)`, que revierte cuando se agotan). Los primeros en redimir capturan el claim contable; el resto queda sin nada. Igual que H2, es redistribución de claims entre tenedores de HLP0 — **el USDC real (3,27) no alcanza para materializar ganancia**.

---

## 5. Por qué no hay crítico permissionless

Invariantes verificados en el binario de producción:

1. **Toda mutación de `totalAssets()`/`totalSupply()` está role-gated** (`requestRedeem` sólo con tokens propios; `rebase`/`debase`/`syncBacking` = oracle; `amoRedeem` = AMO; `_processRequest` = processor).
2. **Ningún entrypoint permissionless transfiere USDC del vault**: `processRequest`/`processRequestsBatch`/`startBridgingBacking`/`bridgeBackingWithPermit`/`amoRedeem` tienen modifier; `withdraw`/`redeem` revierten; `deposit`/`mint` revierten.
3. **El único movimiento permissionless (`requestRedeem`) consume estrictamente tokens del `msg.sender`** (`ERC20InsufficientBalance` lo prueba con 3 montos distintos).
4. **El valor extraíble en USDC es 3,268286 USDC**; no existe combinación de llamadas permissionless que lo supere, y la deuda de 323 855 USDC no es pagable en el estado actual.

---

## 6. Registro de auditoría

### Repos clonados
| repo | commit | resultado |
|---|---|---|
| `hlp0to/hlp0-contracts` (vía fork `nightbox33-cloud/hlp0-contracts`) | `d29208a9ac471a76506b1a2d480c83d80c07fd48` | clonado completo, sin submódulos inicializados (`.gitmodules` apunta a forge-std y openzeppelin-contracts, irrelevantes para el runtime), sin Git LFS |

### Repos bloqueados / no accesibles
- **Ninguno privado detectado**: la org `hlp0to` sólo expone 1 repo público y 0 miembros públicos declarados.
- **Código de producción**: no está en GitHub. Se obtuvo del **fuente verificado** (Sourcify full match + arbiscan/blockscout) para `0xD8Aa810b…1e5D`, `0x7ca13681…` (HLPSHARES), `0x91Bd968a…` (HLPUSDC) y `0x42aCE810…` (HLPAMO). **`ISwapRouter.sol` / `IHyperliquidBridge.sol` de v2 son declaraciones reconstruidas** (sólo firmas; sin lógica bajo prueba).
- **No cubierto**: bytecode de los despliegues en Sonic / HyperEVM / Avalanche (misma dirección reportada por terceros), y estado exacto de `requestProcessor`/`oracleProvider`/`governance` (sin RPC; el explorador no expone `eth_call` en su API pública para estas selectors).

### Archivos inspeccionados
- Repo: `src/HLP0.sol` (322 líneas), `src/HLP0Implementation.sol`, `src/HLPSHARES.sol`, `src/HLPUSDC.sol`, `src/L1Read.sol` (186), `src/interfaces/{IHLPUSDC,IHLPSHARES}.sol`, `foundry.toml`, `package.json`, `.gitmodules`, `.github/workflows/test.yml`.
- Producción (verificado): `src/HLP0.sol` v2, `src/HLPSHARES.sol`, `src/HLPUSDC.sol`, `src/HLPAMO.sol` + `src/interfaces/ISwapRouter.sol`.
- Dependencias: `@layerzerolabs/oft-evm-upgradeable/contracts/oft/{OFTUpgradeable,OFTCoreUpgradeable}.sol`, `oapp-evm-upgradeable/contracts/{oapp/OAppCoreUpgradeable,precrime/OAppPreCrimeSimulatorUpgradeable}.sol`, `@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol` (5.3.0), `lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol`.
- Exploradores: arbiscan `#code` + `#readContract` (proxy y impl), blockscout API v1/v2, Sourcify v2 `fields=sources`, hlp0.to/earn, geckoterminal/coinbase/holder.io/kriptomat (direcciones multi-chain).

### Tests / PoCs locales ejecutados
```bash
cd poc/deps && npm install                 # OZ 5.3.0, LZ oft-evm 3.1.4, oft-evm-upgradeable 3.1.0, oapp-evm 0.3.2
cd ../.. && npm install --save-dev solc@0.8.26 @ethereumjs/{vm,common,util,tx}

POC_EXTRA_DIRS=poc/contracts node poc/compile.js          # repo head
node poc/scenario.js                                     # → poc/logs/v1.txt
node poc/slot.js                                         # namespace ERC-7201

POC_SRC_ONLY_PROD=1 POC_EXTRA_DIRS=poc/contracts node poc/compile.js
node poc/prod_scenario.js                                # → poc/logs/prod.txt
node poc/prod_privileged.js                              # → poc/logs/prod.txt
```
Salidas íntegras en `poc/logs/v1.txt` y `poc/logs/prod.txt`. Compilación limpia: 66 unidades (repo) y 61 (prod), 0 errores.

### Falsos positivos descartados (y por qué)
| hipótesis | veredicto | evidencia |
|---|---|---|
| burn de HLPSHARES ajenas en `requestRedeem` | **falso** | `ERC20InsufficientBalance` en `_burn(msg.sender, …)`, 3 montos probados |
| colisión de storage ERC-7201 | **falso** | slot hardcodeado recomputado + 7 namespaces comparados |
| manipulación de ratio vía OFT | **falso** | el path OFT no lee `totalSupply()`; `HLPUSDC/HLPSHARES` no se mueven al puentear |
| reentrancy permissionless | **falso** | sin llamadas externas controlables; USDC sin hooks; burns minter-gated |
| inflación de shares por donación | **falso** | depósitos cerrados; donar sólo sube el ratio a favor de terceros |
| `L1Read` como superficie de fondos | **falso** | wrapper de precompilados, sin estado ni balance |
