// Verify the hardcoded ERC-7201 storage location in src/HLP0.sol:57-58
const { utils: u } = require('ethers');
const keccak256 = u.keccak256, toUtf8Bytes = u.toUtf8Bytes;
const zeroPadValue = (h, n) => u.hexZeroPad(h, n);
const toBeHex = (v, n) => u.hexZeroPad(u.hexlify(v), n);
const h = BigInt(keccak256(toUtf8Bytes('hlp0.storage.v1')));
const slot = BigInt(keccak256(zeroPadValue(toBeHex(h - 1n), 32))) & ~0xffn;
console.log('computed      :', toBeHex(slot, 32));
console.log('in src/HLP0   : 0x632e63c36994fde50a28692a18d8c598076154da1d58d92f102f288e0a379b00');
console.log('MATCH         :', toBeHex(slot, 32) === '0x632e63c36994fde50a28692a18d8c598076154da1d58d92f102f288e0a379b00');

// compare with namespaces actually used by the dependency stack it inherits
const namespaces = [
  'oz.erc20.storage', 'oz.access.ownable', 'oz.utils.reentrancyguard',
  'layerzerov2.storage.oappcore', 'layerzerov2.storage.oftcore',
  'layerzerov2.storage.oappreceiver', 'layerzerov2.storage.options3',
  'layerzerov2.storage.precrime',
];
for (const ns of namespaces) {
  const x = BigInt(keccak256(toUtf8Bytes(ns)));
  const s = BigInt(keccak256(zeroPadValue(toBeHex(x - 1n), 32))) & ~0xffn;
  console.log('ns', ns.padEnd(34), toBeHex(s, 32), toBeHex(s,32) === '0x632e63c36994fde50a28692a18d8c598076154da1d58d92f102f288e0a379b00' ? '<-- COLLISION' : 'ok');
}
