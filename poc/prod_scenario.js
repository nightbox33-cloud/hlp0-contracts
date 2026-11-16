// ============================================================================
// HLP0 PRODUCTION-code adversarial test.
// Contract source = verified implementation 0xD8Aa810b9C23c7a80E1D5e67Cf534DCF956B1e5D
// (poc/prod/src/HLP0.sol, reproduced from Sourcify) deployed behind the real
// proxy 0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81 on Arbitrum.
// Live state (read from the explorer, not RPC): HLPUSDC 387,907.012732 ;
// HLPSHARES 378,245.746236 ; USDC 3.268286 ; pendingUsdcDebt 323,855.093307.
// Local EVM. No RPC, no fork.
// ============================================================================
const { Chain, ARBITRUM_USDC, decodeRevert } = require('./harness');

const A_USDC = 6;
const usdc = (n) => BigInt(Math.round(n * 1e6));
const fmt = (x) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
const log = (...a) => console.log(...a);

// ---- live production addresses -------------------------------------------
const PROD_HLP0_PROXY = '0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81';
const PROD_HLPSHARES = '0x7ca13681dfb071de2c6461adb7a29a950743afdf';
const PROD_HLPUSDC = '0x91Bd968a8bd27C08B9Fc7173d0F475411a6214C5';
const PROD_LZ_ENDPOINT = '0x1a44076050125825900e736c501f859c50fE728c';
const PROD_AMO = '0x42aCE8104bcEbfCD56E4fF0eC72E97E38E5d2727';

// ---- live production numbers -------------------------------------------
const LIVE_HLPUSDC_SUPPLY = 387907012732n; // totalAssets()
const LIVE_HLPSHARES_SUPPLY = 378245746236n; // ERC4626 totalSupply()
const LIVE_USDC_IN_VAULT = 3268286n; // contract USDC balance
const LIVE_PENDING_DEBT = 323855093307n; // pendingUsdcDebt()

async function installCode(chain, address, name) {
  const { ART } = require('./harness');
  const { Address, Account } = require('@ethereumjs/util');
  const addr = Address.fromString(address);
  await chain.vm.stateManager.putAccount(addr, new Account(0n, 0n));
  await chain.vm.stateManager.putContractCode(addr, Buffer.from(ART[name].deployed.slice(2), 'hex'));
}

async function main() {
  const chain = await new Chain().init();
  const A = {
    gov: chain.addActor('gov'),
    oracle: chain.addActor('oracle'),
    processor: chain.addActor('processor'),
    alice: chain.addActor('alice'),
    bob: chain.addActor('bob'),
    holder: chain.addActor('holder'), // HLP0 holder, holds existing supply
    attacker: chain.addActor('attacker'),
  };

  await installCode(chain, ARBITRUM_USDC, 'MockUSDC');
  await installCode(chain, PROD_HLPSHARES, 'HLPSHARES');
  await installCode(chain, PROD_HLPUSDC, 'HLPUSDC');
  // EndpointV2 is immutable in the implementation (constructor arg). Production
  // used 0x1a44...728c, so install the endpoint stub at that exact address.
  const endpoint = await chain.deploy('MockLZEndpoint', [usdc(0.01)]);
  {
    const { Address, Account } = require('@ethereumjs/util');
    const ep = Address.fromString(PROD_LZ_ENDPOINT);
    const code = await chain.vm.stateManager.getContractCode(Address.fromString(endpoint));
    const stor = await chain.vm.stateManager.getContractStorage(
      Address.fromString(endpoint),
      require('@ethereumjs/util').hexToBytes('0x' + '00'.repeat(32)));
    await chain.vm.stateManager.putAccount(ep, new Account(0n, 0n));
    await chain.vm.stateManager.putContractCode(ep, code);
    await chain.setRaw(PROD_LZ_ENDPOINT, 0n, usdc(0.01)); // nativeFee immutable lives in code, not storage
  }
  const impl = await chain.deploy('HLP0', [PROD_LZ_ENDPOINT]);
  // NOTE: implementation is compiled from prod source; the deployed impl used the
  // real endpoint constant as ctor arg, reproduced above.
  const vault = PROD_HLP0_PROXY;
  {
    // Deploy the proxy normally, then relocate its runtime code + ERC-1967
    // impl slot to the real production proxy address, so every call in this
    // scenario executes against 0x3D75...6C81 exactly as on Arbitrum.
    const { ART } = require('./harness');
    const { Address, Account, hexToBytes } = require('@ethereumjs/util');
    const tmpProxy = await chain.deploy('SimpleProxy', [impl]);
    const runtime = await chain.vm.stateManager.getContractCode(Address.fromString(tmpProxy));
    await chain.vm.stateManager.putAccount(Address.fromString(vault), new Account(0n, 0n));
    await chain.vm.stateManager.putContractCode(Address.fromString(vault), runtime);
    // ESSENTIAL: storage does not travel with code. Re-point the ERC-1967
    // implementation slot of the relocated proxy at our implementation.
    const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    await chain.setRaw(vault, IMPL_SLOT, BigInt(impl));
    const chk = await chain.view(vault, 'token()');
    log('proxy wired -> implementation token() =', chk[0], '(self)');
  }
  for (const n of Object.keys(A)) await chain.setBalance(A[n], 10n ** 24n);

  async function must(label, to, sig, args, from) {
    const r = await chain.tx(to, sig, args, { from });
    if (r.execResult.exceptionError) {
      throw new Error(`${label} REVERTED: ${decodeRevert(r.execResult.returnValue)}`);
    }
    return r;
  }
  async function attempt(label, to, sig, args, from) {
    const r = await chain.tx(to, sig, args, { from });
    const ok = !r.execResult.exceptionError;
    return { label, ok, err: ok ? null : decodeRevert(r.execResult.returnValue) };
  }

  // minter wiring exactly as production: the deployer EOA deployed
  // HLPUSDC/HLPSHARES (constructor sets minter=msg.sender) and later called
  // setMinter(HLP0). Seed storage to that end state.
  await chain.setMinter(PROD_HLPUSDC, vault);
  await chain.setMinter(PROD_HLPSHARES, vault);
  // live token supplies, as read from the explorer
  await chain.setStandardSupply(PROD_HLPUSDC, LIVE_HLPUSDC_SUPPLY);
  await chain.setStandardSupply(PROD_HLPSHARES, LIVE_HLPSHARES_SUPPLY);
  await chain.setStandardBalance(PROD_HLPUSDC, vault, LIVE_HLPUSDC_SUPPLY, 0n);
  await chain.setStandardBalance(PROD_HLPSHARES, vault, LIVE_HLPSHARES_SUPPLY, 0n);
  await must('HLP0.initialize', vault, 'initialize(string,string,address,address,address,address)',
    ['HyperLiquidity Provider OFT', 'HLP0', PROD_HLPUSDC, PROD_HLPSHARES, A.gov, A.gov], 'gov');
  await must('setOracleProvider', vault, 'setOracleProvider(address)', [A.oracle], 'gov');
  await must('setRequestProcessor', vault, 'setRequestProcessor(address)', [A.processor], 'gov');

  // ---- replay the live on-chain token state (no RPC: values read from explorer)
  await must('fund vault USDC', ARBITRUM_USDC, 'mint(address,uint256)', [vault, LIVE_USDC_IN_VAULT], 'deployer');
  // existing HLP0 holders = HLPSHARES supply still circulating as HLP0 tokens
  // (v1->v2 recorded as unredeemed). Represent them with a distribution.
  // Existing HLP0 holders (the v2 migration carried unredeemed balances over).
  // Seed the HLP0 ERC20 layer directly: NO tokens are minted to the attacker.
  const holderShares = LIVE_HLPSHARES_SUPPLY;
  await chain.setOZSupply(vault, holderShares);
  await chain.setOZBalance(vault, A.holder, holderShares);
  await chain.setOZBalance(vault, A.attacker, 0n);

  const q = async (sig, args = []) => (await chain.view(vault, sig, args))[0];
  const snap = async () => ({
    totalAssets: await q('totalAssets()'),
    totalSupply: await q('totalSupply()'),
    actualSupply: await q('actualTotalSupply()'),
    ratio: await q('ratio()'),
    usdcInVault: await chain.balanceOfUsdc(ARBITRUM_USDC, vault),
    attackerHlp0: await q('balanceOf(address)', [A.attacker]),
    holderHlp0: await q('balanceOf(address)', [A.holder]),
    pendingDebt: await q('pendingUsdcDebt()'),
  });

  // live pendingUsdcDebt (read from explorer): Storage.pendingUsdcDebt is the
  // 9th member of the ERC-7201 struct -> STORAGE_LOCATION + 8.
  await chain.setRaw(vault,
    BigInt('0x632e63c36994fde50a28692a18d8c598076154da1d58d92f102f288e0a379b00') + 8n,
    LIVE_PENDING_DEBT);
  const s0 = await snap();
  log('== production state replayed (values read from Arbitrum explorer) ==');
  log('totalAssets (HLPUSDC)   =', fmt(s0.totalAssets));
  log('totalSupply (HLPSHARES) =', fmt(s0.totalSupply));
  log('ratio                   =', s0.ratio.toString(), '(HLPUSDC per HLP0)');
  log('USDC actually in vault  =', fmt(s0.usdcInVault));
  log('pendingUsdcDebt         =', fmt(s0.pendingDebt));
  log('=> the vault owes', fmt(s0.pendingDebt), 'USDC to redeemers but holds', fmt(s0.usdcInVault), 'USDC');

  const results = {};

  // -------------------------------------------------------------------------
  // PATH A: can an unprivileged caller make the contract pay them USDC?
  // requestRedeem burns msg.sender's own HLP0 (ERC20 _burn -> cannot exceed
  // balance), and _processRequest is processor-gated. Try all permutations.
  // -------------------------------------------------------------------------
  results.permissionlessPayouts = [
    await attempt('processRequest(0)', vault, 'processRequest(uint256)', [0n], 'attacker'),
    await attempt('processRequestsBatch([0])', vault, 'processRequestsBatch(uint256[])', [[0n]], 'attacker'),
    await attempt('startBridgingBacking', vault, 'startBridgingBacking()', [], 'attacker'),
    await attempt('amoRedeem(0,1)', vault, 'amoRedeem(uint256,uint256)', [0n, 1n], 'attacker'),
    await attempt('bridgeBackingWithPermit', vault, 'bridgeBackingWithPermit((bytes32,bytes32,uint8),uint64,uint64)',
      [['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 27], 99999999999n, 1n], 'attacker'),
    await attempt('syncBacking(1)', vault, 'syncBacking(uint256)', [1n], 'attacker'),
    await attempt('rebase(1e18)', vault, 'rebase(uint256)', [10n ** 18n], 'attacker'),
    await attempt('debase(1e6)', vault, 'debase(uint256)', [1000000n], 'attacker'),
    await attempt('setGovernance(attacker)', vault, 'setGovernance(address)', [A.attacker], 'attacker'),
    await attempt('setOracleProvider(attacker)', vault, 'setOracleProvider(address)', [A.attacker], 'attacker'),
    await attempt('setRequestProcessor(attacker)', vault, 'setRequestProcessor(address)', [A.attacker], 'attacker'),
    await attempt('setPeer(1,attacker)', vault, 'setPeer(uint32,bytes32)', [1, '0x' + '00'.repeat(12) + A.attacker.slice(2)], 'attacker'),
    await attempt('deposit(100e6)', vault, 'deposit(uint256,address)', [usdc(100), A.attacker], 'attacker'),
    await attempt('mint(100e6)', vault, 'mint(uint256,address)', [usdc(100), A.attacker], 'attacker'),
    await attempt('withdraw', vault, 'withdraw(uint256,address,address)', [1n, A.attacker, A.attacker], 'attacker'),
    await attempt('redeem', vault, 'redeem(uint256,address,address)', [1n, A.attacker, A.attacker], 'attacker'),
  ];

  // -------------------------------------------------------------------------
  // PATH B: can an unprivileged caller inflate their HLP0 / sell into the pool
  // at an inflated ratio? (share/asset accounting abuse)
  // -------------------------------------------------------------------------
  // Attacker cannot obtain HLP0 (deposits closed, no mint path) -> try burning
  // more than they own, and burning with all HLP0 they could scrape from
  // dust balances.
  results.inflation = [
    await attempt('requestRedeem(1e18)', vault, 'requestRedeem(uint256)', [10n ** 18n], 'attacker'),
    await attempt('requestRedeem(totalSupply)', vault, 'requestRedeem(uint256)', [LIVE_HLPSHARES_SUPPLY], 'attacker'),
    await attempt('requestRedeem(holderShares) as attacker', vault, 'requestRedeem(uint256)', [holderShares], 'attacker'),
  ];

  log('\n== PATH A: permissionless payout attempts (all must fail) ==');
  for (const r of results.permissionlessPayouts) log(` ${r.ok ? 'SUCCESS <-- !!!' : 'blocked  '} ${r.label.padEnd(38)} ${r.err || ''}`);
  log('\n== PATH B: share inflation / unauthorised burn ==');
  for (const r of results.inflation) log(` ${r.ok ? 'SUCCESS <-- !!!' : 'blocked  '} ${r.label.padEnd(38)} ${r.err || ''}`);

  // -------------------------------------------------------------------------
  // PATH C: legitimate redemption, to show where the shortfall lands.
  // The holder redeems; requestRedeem burns their HLP0 + HLPSHARES + HLPUSDC
  // and records the debt. processRequest then pays *actual USDC*. With only
  // 3.268286 USDC in the contract and 323,855 USDC of debt, redemptions are
  // first-come-first-served.
  // -------------------------------------------------------------------------
  const holderBal = await q('balanceOf(address)', [A.holder]);
  const redeemAmt = 300000n * 1n; // 300,000 HLP0 (> MIN_REDEEM_AMOUNT)
  log('\n== PATH C: honest redemption of 300,000 HLP0 ==');
  const rr = await attempt('requestRedeem(300000e6)', vault, 'requestRedeem(uint256)', [usdc(300000)], 'holder');
  log(' requestRedeem ->', rr.ok ? 'SUCCESS' : 'REVERT: ' + rr.err);
  if (rr.ok) {
    const s1 = await snap();
    log(' totalAssets after burn  =', fmt(s1.totalAssets));
    log(' pendingUsdcDebt after   =', fmt(s1.pendingDebt));
    log(' USDC in vault           =', fmt(s1.usdcInVault), '(unchanged)');
    const pr = await attempt('processRequest(last)', vault, 'processRequest(uint256)', [0n], 'processor');
    log(' processRequest ->', pr.ok ? 'SUCCESS (paid from the 3.26 USDC left)' : 'REVERT: ' + pr.err);
    const s2 = await snap();
    log(' USDC in vault after     =', fmt(s2.usdcInVault));
    results.honestRedemption = { paid: s1.usdcInVault - s2.usdcInVault, debt: s2.pendingDebt };
  }

  // -------------------------------------------------------------------------
  // PATH D: cross-chain OFT round trip - does bridged HLP0 keep a claim?
  // -------------------------------------------------------------------------
  log('\n== PATH D: OFT send (burn on src) then credit on dst ==');
  const sendParam = [30184, '0x' + '00'.repeat(12) + A.attacker.slice(2).padStart(40, '0'),
    usdc(100), usdc(100), '0x', '0x', '0x'];
  const qs = await attempt('quoteSend', vault, 'quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)',
    [sendParam, false], 'attacker');
  log(' quoteSend ->', qs.ok ? 'ok' : 'REVERT: ' + qs.err, '(no peer configured locally)');

  console.log('\n' + JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
