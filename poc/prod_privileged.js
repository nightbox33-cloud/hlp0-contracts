// ============================================================================
// HLP0 PRODUCTION code — privileged-role and redemption-queue analysis.
// Source: verified implementation 0xD8Aa810b9C23c7a80E1D5e67Cf534DCF956B1e5D
// (poc/prod/src/HLP0.sol). Live parameters/state read from the explorer and
// seeded below. Local EVM, no RPC, no fork.
// ============================================================================
const { Chain, ARBITRUM_USDC, decodeRevert } = require('./harness');

const usdc = (n) => BigInt(Math.round(n * 1e6));
const fmt = (x) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
const log = (...a) => console.log(...a);

const PROD_HLP0_PROXY = '0x3D75F2BB8aBcDBd1e27443cB5CBCE8A668046C81';
const PROD_HLPSHARES = '0x7ca13681dfb071de2c6461adb7a29a950743afdf';
const PROD_HLPUSDC = '0x91Bd968a8bd27C08B9Fc7173d0F475411a6214C5';
const PROD_LZ_ENDPOINT = '0x1a44076050125825900e736c501f859c50fE728c';

// live values (Arbitrum explorer)
const LIVE_HLPUSDC = 387907012732n;
const LIVE_HLPSHARES = 378245746236n;
const LIVE_USDC = 3268286n;
const LIVE_DEBT = 323855093307n;

const NS = '0x632e63c36994fde50a28692a18d8c598076154da1d58d92f102f288e0a379b00';
const SLOT_LAST_ORACLE = BigInt(NS) + 5n;
const SLOT_PENDING_DEBT = BigInt(NS) + 8n;

async function main() {
  const chain = await new Chain().init();
  const A = {
    gov: chain.addActor('gov'), oracle: chain.addActor('oracle'),
    processor: chain.addActor('processor'), holderA: chain.addActor('holderA'),
    holderB: chain.addActor('holderB'), attacker: chain.addActor('attacker'),
  };
  const { ART } = require('./harness');
  const { Address, Account } = require('@ethereumjs/util');
  const install = async (addr, name) => {
    const a = Address.fromString(addr);
    await chain.vm.stateManager.putAccount(a, new Account(0n, 0n));
    await chain.vm.stateManager.putContractCode(a, Buffer.from(ART[name].deployed.slice(2), 'hex'));
  };
  await install(ARBITRUM_USDC, 'MockUSDC');
  await install(PROD_HLPSHARES, 'HLPSHARES');
  await install(PROD_HLPUSDC, 'HLPUSDC');
  const epTmp = await chain.deploy('MockLZEndpoint', [usdc(0.01)]);
  await chain.vm.stateManager.putAccount(Address.fromString(PROD_LZ_ENDPOINT), new Account(0n, 0n));
  await chain.vm.stateManager.putContractCode(Address.fromString(PROD_LZ_ENDPOINT),
    await chain.vm.stateManager.getContractCode(Address.fromString(epTmp)));

  const impl = await chain.deploy('HLP0', [PROD_LZ_ENDPOINT]);
  const tmp = await chain.deploy('SimpleProxy', [impl]);
  const vault = PROD_HLP0_PROXY;
  await chain.vm.stateManager.putAccount(Address.fromString(vault), new Account(0n, 0n));
  await chain.vm.stateManager.putContractCode(Address.fromString(vault),
    await chain.vm.stateManager.getContractCode(Address.fromString(tmp)));
  await chain.setRaw(vault, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', BigInt(impl));
  for (const n of Object.keys(A)) await chain.setBalance(A[n], 10n ** 24n);

  const must = async (l, to, sig, args, from) => {
    const r = await chain.tx(to, sig, args, { from });
    if (r.execResult.exceptionError) throw new Error(`${l}: ${decodeRevert(r.execResult.returnValue)}`);
    return r;
  };
  const attempt = async (l, to, sig, args, from) => {
    const r = await chain.tx(to, sig, args, { from });
    return { label: l, ok: !r.execResult.exceptionError, err: r.execResult.exceptionError ? decodeRevert(r.execResult.returnValue) : null };
  };

  // ---- deployment state -------------------------------------------------
  await must('init', vault, 'initialize(string,string,address,address,address,address)',
    ['HLP0', 'HLP0', PROD_HLPUSDC, PROD_HLPSHARES, A.gov, A.gov], 'gov');
  await must('setOracleProvider', vault, 'setOracleProvider(address)', [A.oracle], 'gov');
  await must('setRequestProcessor', vault, 'setRequestProcessor(address)', [A.processor], 'gov');
  await chain.setMinter(PROD_HLPUSDC, vault);
  await chain.setMinter(PROD_HLPSHARES, vault);
  await chain.setStandardSupply(PROD_HLPUSDC, LIVE_HLPUSDC);
  await chain.setStandardSupply(PROD_HLPSHARES, LIVE_HLPSHARES);
  await chain.setStandardBalance(PROD_HLPUSDC, vault, LIVE_HLPUSDC, 0n);
  await chain.setStandardBalance(PROD_HLPSHARES, vault, LIVE_HLPSHARES, 0n);
  await must('seed vault USDC', ARBITRUM_USDC, 'mint(address,uint256)', [vault, LIVE_USDC], 'deployer');
  await chain.setOZSupply(vault, LIVE_HLPSHARES);
  const half = LIVE_HLPSHARES / 2n;
  await chain.setOZBalance(vault, A.holderA, half);
  await chain.setOZBalance(vault, A.holderB, LIVE_HLPSHARES - half);
  await chain.setRaw(vault, SLOT_PENDING_DEBT, LIVE_DEBT);
  // local chain starts at block.timestamp 0 within ORACLE_STALE_INTERVAL (see note)
  await chain.setRaw(vault, SLOT_LAST_ORACLE, 0n);

  const q = async (sig, args = []) => (await chain.view(vault, sig, args))[0];
  log('== production state (seeded from live Arbitrum values) ==');
  log(' totalAssets(HLPUSDC) =', fmt(await q('totalAssets()')),
    '| totalSupply(HLPSHARES) =', fmt(await q('totalSupply()')),
    '| ratio =', (await q('ratio()')).toString());
  log(' USDC in vault =', fmt(await chain.balanceOfUsdc(ARBITRUM_USDC, vault)),
    '| pendingUsdcDebt =', fmt(await q('pendingUsdcDebt()')));

  const out = {};

  // =====================================================================
  // (A) oracle debase(): 0.2% per-call cap, no cumulative cap, and the
  //     1.0 floor is evaluated against the *current* pending debt.
  // =====================================================================
  log('\n== (A) debase(): per-call 0.2% cap is not a cumulative cap ==');
  const sharesT = await q('totalSupply()');
  out.debase = [];
  for (let i = 0; i < 5; i++) {
    const burn = (await q('totalSupply()')) / 1000n; // 0.1% of ratio
    const r = await attempt(`debase #${i + 1} (burn ${fmt(burn)})`, vault, 'debase(uint256)', [burn], 'oracle');
    out.debase.push({ i: i + 1, ok: r.ok, err: r.err,
      ratio: (await q('ratio()')).toString(), totalAssets: (await q('totalAssets()')).toString() });
  }
  for (const x of out.debase) {
    log(`  ${x.ok ? 'ok     ' : 'blocked'} burn#${x.i} -> ratio ${(Number(x.ratio) / 1e6).toFixed(6)} totalAssets ${fmt(BigInt(x.totalAssets))}` + (x.err ? '  ' + x.err : ''));
  }
  log('  result: ratio walked from 1.025542 down to', (Number((await q('ratio()')) / 1000n) / 1000).toFixed(6),
    'via repeated <=0.2% steps; each call passes the per-call cap.');

  // =====================================================================
  // (B) redemption queue is first-come-first-served and unpayable:
  //     requestRedeem burns HLP0/HLPSHARES/HLPUSDC and only books a debt.
  //     Whether a holder is paid depends purely on the contract's USDC
  //     balance at processRequest time.
  // =====================================================================
  log('\n== (B) redemption queue (real USDC balance ~= 0) ==');
  const rA = await attempt('holderA requestRedeem(half)', vault, 'requestRedeem(uint256)', [half], 'holderA');
  const rB = await attempt('holderB requestRedeem(half)', vault, 'requestRedeem(uint256)', [half], 'holderB');
  log(' holderA requestRedeem ->', rA.ok ? 'accepted (HLP0+shares+backing burnt)' : rA.err);
  log(' holderB requestRedeem ->', rB.ok ? 'accepted (HLP0+shares+backing burnt)' : rB.err);
  const debtNow = await q('pendingUsdcDebt()');
  const payA = await attempt('processRequest(idA)', vault, 'processRequest(uint256)', [0n], 'processor');
  const payB = await attempt('processRequest(idB)', vault, 'processRequest(uint256)', [1n], 'processor');
  log(' pendingUsdcDebt =', fmt(debtNow), '| USDC in vault =', fmt(await chain.balanceOfUsdc(ARBITRUM_USDC, vault)));
  log(' processRequest(A) ->', payA.ok ? 'PAID' : 'REVERT: ' + payA.err);
  log(' processRequest(B) ->', payB.ok ? 'PAID' : 'REVERT: ' + payB.err);
  out.fcfs = { rA, rB, debt: debtNow.toString(), payA, payB };

  // =====================================================================
  // (C) requestProcessor trust: startBridgingBacking() sweeps the contract
  //     balance to a single EOA; no multisig/timelock in code.
  // =====================================================================
  log('\n== (C) requestProcessor can sweep the contract USDC ==');
  const balBefore = await chain.balanceOfUsdc(ARBITRUM_USDC, vault);
  await must('startBridgingBacking', vault, 'startBridgingBacking()', [], 'processor');
  out.processorSweep = {
    before: balBefore.toString(),
    after: (await chain.balanceOfUsdc(ARBITRUM_USDC, vault)).toString(),
    processorBalance: (await chain.balanceOfUsdc(ARBITRUM_USDC, A.processor)).toString(),
  };
  log(` vault ${fmt(balBefore)} -> ${fmt(BigInt(out.processorSweep.after))} | requestProcessor ${fmt(BigInt(out.processorSweep.processorBalance))}`);

  // =====================================================================
  // (D) oracle can mint/burn backing without any holder action:
  //     syncBacking() writes HLPUSDC + HLPSHARES balances directly.
  // =====================================================================
  log('\n== (D) syncBacking(): oracle-only backing rewrite (guarded) ==');
  const sb = await attempt('syncBacking(+1e6)', vault, 'syncBacking(uint256)',
    [(await q('totalAssets()')) + 1000000n], 'oracle');
  const sb2 = await attempt('syncBacking(target)', vault, 'syncBacking(uint256)', [usdc(3_000_001)], 'oracle');
  log(' syncBacking(current+1) ->', sb.ok ? 'ok' : 'REVERT: ' + sb.err, '(ratio moves <=1 wei check)');
  log(' syncBacking(3,000,001) ->', sb2.ok ? 'ok' : 'REVERT: ' + sb2.err, '(TOO SMALL floor)');
  out.syncBacking = { plusOne: sb, target: sb2 };

  console.log('\n' + JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
