// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev ERC-5219 header/query pair.
struct KeyValue {
    string key;
    string value;
}

/// @title PeerCashPage
/// @notice The Peer Cash Demo, an example integration of the zkp2p cash SDK,
///         stored entirely onchain on Base. The page (markup, styles, and
///         the bundled SDK) is split byte-for-byte across the runtime
///         bytecode of immutable data contracts deployed just before this
///         wrapper; `html()` reassembles them with EXTCODECOPY and
///         `request()` serves the result per ERC-5219, advertised via
///         ERC-4804 `resolveMode()`. Nothing here can mutate the response.
///
///         Both view functions ABI-encode their return data in assembly so
///         the multi-megabyte page is written to memory exactly once;
///         letting Solidity's encoder copy it again would roughly quadruple
///         the quadratic memory cost and push reads past common `eth_call`
///         gas caps. After zSwap by z0r0z (https://github.com/z-fi/zFi).
contract PeerCashPage {
    /// @notice Data contracts whose concatenated runtime bytecode is the page.
    address[] private _chunks;

    error InvalidData();

    constructor(address[] memory chunkList) payable {
        if (chunkList.length == 0) revert InvalidData();
        for (uint256 i; i != chunkList.length; ++i) {
            if (chunkList[i].code.length == 0) revert InvalidData();
        }
        _chunks = chunkList;
    }

    /// @notice The data contracts, in concatenation order.
    function chunks() external view returns (address[] memory) {
        return _chunks;
    }

    /// @notice The full page as a string.
    function html() external view returns (string memory) {
        uint256 head;
        assembly {
            head := mload(0x40)
        }
        // abi: [0x20][length][bytes…]
        uint256 total = _writePage(head + 0x40);
        assembly {
            mstore(head, 0x20)
            mstore(add(head, 0x20), total)
            return(head, add(0x40, and(add(total, 0x1f), not(0x1f))))
        }
    }

    /// @notice ERC-5219 resource request: every path serves the page.
    function request(string[] memory, KeyValue[] memory)
        external
        view
        returns (uint16, string memory, KeyValue[] memory)
    {
        uint256 head;
        assembly {
            head := mload(0x40)
        }
        // abi: [200][0x60][headers offset][body length][body…][headers tail]
        uint256 total = _writePage(head + 0x80);
        assembly {
            let padded := and(add(total, 0x1f), not(0x1f))
            mstore(head, 200)
            mstore(add(head, 0x20), 0x60)
            mstore(add(head, 0x40), add(0x80, padded))
            mstore(add(head, 0x60), total)
            // headers tail: KeyValue[2] of ("Content-Type", "text/html") and
            // ("Cache-Control", "public, max-age=31536000, immutable")
            let h := add(add(head, 0x80), padded)
            mstore(h, 2)
            mstore(add(h, 0x20), 0x40)
            mstore(add(h, 0x40), 0x100)
            mstore(add(h, 0x60), 0x40)
            mstore(add(h, 0x80), 0x80)
            mstore(add(h, 0xa0), 12)
            mstore(add(h, 0xc0), 0x436f6e74656e742d547970650000000000000000000000000000000000000000)
            mstore(add(h, 0xe0), 9)
            mstore(add(h, 0x100), 0x746578742f68746d6c0000000000000000000000000000000000000000000000)
            mstore(add(h, 0x120), 0x40)
            mstore(add(h, 0x140), 0x80)
            mstore(add(h, 0x160), 13)
            mstore(add(h, 0x180), 0x43616368652d436f6e74726f6c00000000000000000000000000000000000000)
            mstore(add(h, 0x1a0), 35)
            mstore(add(h, 0x1c0), 0x7075626c69632c206d61782d6167653d33313533363030302c20696d6d757461)
            mstore(add(h, 0x1e0), 0x626c650000000000000000000000000000000000000000000000000000000000)
            return(head, add(add(0x80, padded), 0x200))
        }
    }

    /// @notice ERC-4804 resolve mode: ERC-5219 resource requests.
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @dev Concatenate every chunk's runtime bytecode at `dst`. Memory past
    ///      the free pointer is untouched zeroes, so the padding after the
    ///      last byte needs no cleanup.
    function _writePage(uint256 dst) private view returns (uint256 total) {
        assembly {
            let at := dst
            mstore(0x00, _chunks.slot)
            let base := keccak256(0x00, 0x20)
            let n := sload(_chunks.slot)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let a := sload(add(base, i))
                let size := extcodesize(a)
                extcodecopy(a, at, 0, size)
                at := add(at, size)
            }
            total := sub(at, dst)
        }
    }
}
