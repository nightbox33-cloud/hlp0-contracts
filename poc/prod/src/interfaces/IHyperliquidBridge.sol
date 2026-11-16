// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// NOTE (audit PoC): reconstructed interface. HLP0.sol references
// IHyperliquidBridge.DepositWithPermit / .Signature inside a
// OnlyRequestProcessor function. Signatures below are inferred from usage;
// they do not affect the accounting logic under test.
interface IHyperliquidBridge {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    struct DepositWithPermit {
        address user;
        uint64 usd;
        uint64 deadline;
        Signature signature;
    }

    function batchedDepositWithPermit(DepositWithPermit[] calldata deposits) external;
}
