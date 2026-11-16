// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Local stand-in for LayerZero V2 EndpointV2. Implements exactly the
/// surface OFT/OApp touch: quote(), send(), setDelegate(). Fee is flat so the
/// PoC maths is deterministic; the fee model is irrelevant to the claim.
contract MockLZEndpoint {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    uint256 public immutable nativeFee;
    uint64 public nonce;
    address public delegate;
    uint256 public totalNativeCollected;

    constructor(uint256 _nativeFee) {
        nativeFee = _nativeFee;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(nativeFee, 0);
    }

    function send(
        MessagingParams calldata _params,
        address /*_refundAddress*/
    ) external payable returns (MessagingReceipt memory) {
        require(msg.value == nativeFee, "ENDPOINT: FEE MISMATCH");
        nonce++;
        totalNativeCollected += msg.value;
        return MessagingReceipt(keccak256(abi.encode(_params, nonce)), nonce, MessagingFee(nativeFee, 0));
    }

    function setDelegate(address _delegate) external {
        delegate = _delegate;
    }
}
