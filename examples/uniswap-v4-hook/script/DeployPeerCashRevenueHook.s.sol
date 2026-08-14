// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PeerCashRevenueHook} from "../src/PeerCashRevenueHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Script} from "forge-std/Script.sol";

contract DeployPeerCashRevenueHook is Script {
    uint256 internal constant MAX_FEE_BPS = 100;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    IPoolManager internal constant BASE_POOL_MANAGER =
        IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    Currency internal constant BASE_USDC =
        Currency.wrap(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);

    error BaseOnly(uint256 chainId);
    error InvalidFeeBps(uint256 feeBps);
    error HookAddressMismatch(address expected, address deployed);

    function run() external returns (PeerCashRevenueHook hook) {
        if (block.chainid != 8453) revert BaseOnly(block.chainid);

        address beneficiary = vm.envAddress("BENEFICIARY");
        uint256 rawFeeBps = vm.envUint("FEE_BPS");
        if (rawFeeBps == 0 || rawFeeBps > MAX_FEE_BPS) {
            revert InvalidFeeBps(rawFeeBps);
        }
        uint16 feeBps = uint16(rawFeeBps);
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory constructorArgs = abi.encode(BASE_POOL_MANAGER, BASE_USDC, beneficiary, feeBps);

        (address expected, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER, flags, type(PeerCashRevenueHook).creationCode, constructorArgs
        );

        vm.broadcast();
        hook =
            new PeerCashRevenueHook{salt: salt}(BASE_POOL_MANAGER, BASE_USDC, beneficiary, feeBps);

        if (address(hook) != expected) revert HookAddressMismatch(expected, address(hook));
    }
}
