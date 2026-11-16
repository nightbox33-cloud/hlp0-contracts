// Minimal local EVM harness: deploys the *unmodified* HLP0 production contracts
// (compiled from src/) against era-accurate dependencies and executes real
// transactions. No RPC / no fork: state is instantiated from repo constants.
const path = require('path');
const { VM } = require('@ethereumjs/vm');
const { Common, Hardfork } = require('@ethereumjs/common');
const { LegacyTransaction } = require('@ethereumjs/tx');
const {
  Address, Account, hexToBytes, bytesToHex, privateToAddress,
} = require('@ethereumjs/util');

const ART = require('./build/out.json');

const COMMON = new Common({ chain: 'mainnet', hardfork: Hardfork.Cancun });

// ---- production constants read verbatim from src/HLP0.sol -------------------
const ARBITRUM_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'; // HLP0.USDC
const LZ_ENDPOINT = '0x1a44076050125825900e736c501f859c50fe728c';   // LayerZero V2 endpoint (Arbitrum)

class Chain {
  constructor() {
    this.vm = null;
    this.nonce = 0;
    this.txs = [];
  }
  async init() {
    this.vm = await VM.create({ common: COMMON });
    this.keys = {};
    this.addrs = {};
    this.sender = this.addActor('deployer');
    await this._fund(this.sender, 10n ** 24n);
    return this;
  }
  // Deterministic keypair per named actor so real signed txs can originate
  // from any address that must satisfy an on-chain role check.
  addActor(name) {
    const pk = new Uint8Array(hexToBytes(ethersUtils.keccak256(ethersUtils.toUtf8Bytes('hlp0-poc::' + name))));
    const addr = bytesToHex(privateToAddress(pk));
    this.keys[name] = pk;
    this.addrs[name] = addr;
    return addr;
  }
  keyOf(name) {
    const k = this.keys[name];
    if (!k) throw new Error('unknown actor ' + name);
    return k;
  }
  async _fund(addr, wei) {
    await this.vm.stateManager.putAccount(Address.fromString(addr), new Account(0n, wei));
  }
  async setBalance(addr, wei) {
    const a = (await this.vm.stateManager.getAccount(Address.fromString(addr))) || new Account(0n, 0n);
    a.balance = wei;
    await this.vm.stateManager.putAccount(Address.fromString(addr), a);
  }
  async deploy(contractName, args = [], opts = {}) {
    const art = ART[contractName];
    if (!art) throw new Error('no artifact ' + contractName);
    const ctor = art.abi.find((x) => x.type === 'constructor');
    const encoded = ctor && ctor.inputs.length
      ? ethersUtils.defaultAbiCoder.encode(ctor.inputs.map((i) => i.type), args)
      : '';
    const data = hexToBytes(art.bytecode + encoded.slice(2));
    const res = await this.vm.evm.runCall({
      caller: Address.fromString(this.sender),
      to: undefined,
      data,
      gasLimit: 30_000_000n,
      value: 0n,
      origin: Address.fromString(this.sender),
    });
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${contractName} failed: ${res.execResult.exceptionError.error} ${decodeRevert(res.execResult.returnValue)}`);
    }
    return bytesToHex(res.createdAddress.toBytes());
  }
  async call(to, sig, args = [], opts = {}) {
    const data = encodeCall(sig, args);
    const caller = opts.caller || this.sender;
    const res = await this.vm.evm.runCall({
      caller: Address.fromString(caller),
      to: Address.fromString(to),
      data: hexToBytes(data),
      gasLimit: opts.gasLimit || 30_000_000n,
      value: opts.value || 0n,
      origin: Address.fromString(caller),
    });
    return res;
  }
  // executes a real signed transaction so state persists (nonce/receipt semantics)
  async tx(to, sig, args = [], opts = {}) {
    const data = encodeCall(sig, args);
    const vm = this.vm;
    const pk = this.keyOf(opts.from || 'deployer');
    const sender = Address.fromString(bytesToHex(privateToAddress(pk)));
    const acct = await vm.stateManager.getAccount(sender);
    const tx = LegacyTransaction.fromTxData(
      {
        nonce: acct.nonce,
        gasPrice: 10_000_000_000n,
        gasLimit: 30_000_000n,
        to: to ? Address.fromString(to) : undefined,
        value: 0n,
        data: hexToBytes(data),
      },
      { common: COMMON }
    ).sign(pk);
    const res = await vm.runTx({ tx, skipBalance: false, skipNonce: false });
    this.txs.push({ to, sig, ok: !res.execResult.exceptionError, gasUsed: res.totalGasSpent });
    return res;
  }
  async view(to, sig, args = [], caller) {
    const res = await this.call(to, sig, args, { caller });
    if (res.execResult.exceptionError) {
      throw new Error(`view ${sig} reverted: ${decodeRevert(res.execResult.returnValue)}`);
    }
    return decodeReturn(sig, res.execResult.returnValue);
  }
  // ---- raw storage helpers (used to reproduce on-chain deployment state) ----
  async setRaw(addr, slot, value) {
    await this.vm.stateManager.putContractStorage(
      Address.fromString(addr),
      hexToBytes(typeof slot === 'bigint' ? ethersUtils.hexZeroPad(ethersUtils.hexlify(slot), 32) : slot),
      hexToBytes(ethersUtils.hexZeroPad(ethersUtils.hexlify(value), 32))
    );
  }
  async setMinter(addr, minter) { await this.setRaw(addr, 5n, BigInt(minter)); }
  // ERC20Upgradeable (OZ5) balances live at keccak256(abi.encode(account, NS))
  static ERC20_NS = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00';
  async setOZBalance(token, account, amount) {
    const slot = BigInt(ethersUtils.keccak256(
      ethersUtils.defaultAbiCoder.encode(['address', 'uint256'], [account, Chain.ERC20_NS])));
    await this.setRaw(token, slot, amount);
  }
  async setOZSupply(token, amount) {
    await this.setRaw(token, BigInt(Chain.ERC20_NS) + 2n, amount);
  }
  // ERC20 with `mapping(address=>uint256) balanceOf` at storage slot `mapSlot`
  async setStandardBalance(token, account, amount, mapSlot = 3n) {
    const slot = BigInt(ethersUtils.keccak256(
      ethersUtils.defaultAbiCoder.encode(['address', 'uint256'], [account, mapSlot])));
    await this.setRaw(token, slot, amount);
  }
  async setStandardSupply(token, amount, slot = 2n) { await this.setRaw(token, slot, amount); }

  async balanceOfUsdc(token, who) {
    const r = await this.view(token, 'balanceOf(address)', [who]);
    return r[0];
  }
}

// ---------- minimal ABI codec (enough for the selectors used here) ----------
const { utils: ethersUtils } = require('ethers');

function sigHash(sig) {
  return ethersUtils.id(sig).slice(0, 10);
}
// Union ABI interface across every compiled artifact, so calls can be
// encoded/decoded by signature without hand-rolled codecs.
const IFACE = new ethersUtils.Interface(
  Object.values(ART).flatMap((a) => a.abi)
);
function encodeCall(sig, args) {
  return IFACE.encodeFunctionData(sig, args);
}
function decodeReturn(sig, retBytes) {
  const frag = IFACE.getFunction(sig);
  const decoded = IFACE.decodeFunctionResult(frag, bytesToHex(retBytes));
  return frag.outputs.map((_, i) => (typeof decoded[i] === 'object' && decoded[i] && typeof decoded[i].toBigInt === 'function' ? decoded[i].toBigInt() : decoded[i]));
}
function decodeRevert(retBytes) {
  const hex = bytesToHex(retBytes);
  if (hex.startsWith('0x08c379a0')) {
    const len = parseInt(hex.slice(10 + 64, 10 + 128), 16) * 2;
    return Buffer.from(hex.slice(10 + 128, 10 + 128 + len), 'hex').toString();
  }
  if (hex.startsWith('0x4e487b71')) return 'Panic(0x' + hex.slice(10).replace(/0+$/, '') + ')';
  return hex === '0x' ? '<empty revert>' : hex.slice(0, 74);
}

module.exports = { Chain, ART, ARBITRUM_USDC, LZ_ENDPOINT, encodeCall, decodeRevert, decodeReturn };
