// Compiles the HLP0 production sources against era-accurate pinned dependencies
// (see poc/deps/package.json) into a single solc standard-JSON output.
// No network, no RPC: pure source -> bytecode.
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = path.resolve(__dirname, '..');
const DEPS = path.join(__dirname, 'deps');

const remappings = [
  ['@layerzerolabs/oft-evm/', 'node_modules/@layerzerolabs/oft-evm/'],
  ['@layerzerolabs/oft-evm-upgradeable/', 'node_modules/@layerzerolabs/oft-evm-upgradeable/'],
  ['@layerzerolabs/oapp-evm/', 'node_modules/@layerzerolabs/oapp-evm/'],
  ['@layerzerolabs/oapp-evm-upgradeable/', 'node_modules/@layerzerolabs/oapp-evm-upgradeable/'],
  ['@layerzerolabs/lz-evm-protocol-v2/', 'node_modules/@layerzerolabs/lz-evm-protocol-v2/'],
  ['@layerzerolabs/lz-evm-messagelib-v2/', 'node_modules/@layerzerolabs/lz-evm-messagelib-v2/'],
  ['@openzeppelin/contracts/', 'node_modules/@openzeppelin/contracts/'],
  ['@openzeppelin/contracts-upgradeable/', 'node_modules/@openzeppelin/contracts-upgradeable/'],
];

// canonical key per absolute file path
const keyOf = new Map();
const absOf = [];
function keyFor(abs) {
  let k = keyOf.get(abs);
  if (k) return k;
  k = 'u' + absOf.length + '.sol';
  keyOf.set(abs, k);
  absOf.push(abs);
  return k;
}

const contentOf = new Map(); // key -> content
const IMPORT_RE = /^[ \t]*import\b[^;]*;/gm;

function resolveTo(importerAbs, imp) {
  for (const [from, to] of remappings) {
    if (imp.startsWith(from)) {
      return imp.startsWith('@openzeppelin/')
        ? path.join(DEPS, to + imp.slice(from.length))
        : path.join(DEPS, to + imp.slice(from.length));
    }
  }
  if (imp.startsWith('.')) return path.resolve(path.dirname(importerAbs), imp);
  return path.resolve(path.dirname(importerAbs), imp);
}

function add(abs) {
  abs = path.resolve(abs);
  const key = keyFor(abs);
  if (contentOf.has(key)) return key;
  contentOf.set(key, ''); // reserve
  let src = fs.readFileSync(abs, 'utf8');
  src = src.replace(IMPORT_RE, (full) => {
    const m = full.match(/["']([^"']+)["']/);
    if (!m) return full;
    const imp = m[1];
    const target = resolveTo(abs, imp);
    if (!fs.existsSync(target)) {
      console.error('MISSING IMPORT:', imp, 'from', path.relative(ROOT, abs));
      process.exit(1);
    }
    const tkey = add(target);
    return `import "${tkey}";`;
  });
  contentOf.set(key, src);
  return key;
}

const entry = [];
const extraDirs = process.env.POC_EXTRA_DIRS ? process.env.POC_EXTRA_DIRS.split(',') : [];
const baseDirs = process.env.POC_SRC_ONLY_PROD ? [path.resolve(ROOT, 'poc/prod/src')] : [path.join(ROOT, 'src')];
for (const dir of [...baseDirs, ...extraDirs.map(d => path.resolve(ROOT, d))]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.sol')) entry.push(add(path.join(dir, f)));
  }
}

const sources = {};
for (const [k, v] of contentOf) sources[k] = { content: v };

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1000 },
    viaIR: true,
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'storageLayout'] } },
  },
};
console.error('compiling', Object.keys(sources).length, 'source units with', solc.version());
const out = JSON.parse(solc.compile(JSON.stringify(input)));
let errors = 0;
for (const e of out.errors || []) {
  if (e.severity === 'error') errors++;
  console.error(e.formattedMessage);
}
fs.writeFileSync('/tmp/sources.json', JSON.stringify({src: sources, abs: absOf}));
if (errors) process.exit(1);

// Re-key output by human readable name
const named = {};
for (const [k, contracts] of Object.entries(out.contracts)) {
  const rel = path.relative(ROOT, absOf[parseInt(k.slice(1))]);
  for (const [name, c] of Object.entries(contracts)) {
    named[name] = { file: rel, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployed: '0x' + c.evm.deployedBytecode.object, storageLayout: c.storageLayout };
  }
}
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'out.json'), JSON.stringify(named));
console.error('OK ->', Object.keys(named).join(', '));
