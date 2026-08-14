// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PeerCashRevenueHook} from "../src/PeerCashRevenueHook.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract PeerCashRevenueHookTest is Test, Deployers {
    uint16 internal constant FEE_BPS = 50;

    PeerCashRevenueHook internal hook;
    PoolKey internal poolKey;
    Currency internal cashAsset;
    address internal beneficiary;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        cashAsset = currency1;
        beneficiary = makeAddr("beneficiary");

        address hookAddress = address(
            uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG)
                | uint160(0x50454552) << 96
        );
        deployCodeTo(
            "PeerCashRevenueHook.sol:PeerCashRevenueHook",
            abi.encode(manager, cashAsset, beneficiary, FEE_BPS),
            hookAddress
        );
        hook = PeerCashRevenueHook(hookAddress);

        (poolKey,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), 3_000, SQRT_PRICE_1_1
        );
    }

    function test_exactInputAccruesCashAssetOutput() public {
        BalanceDelta delta = swap(poolKey, true, -1e12, ZERO_BYTES);
        uint256 netOutput = uint256(int256(delta.amount1()));
        uint256 fee = hook.revenueAvailable();

        assertGt(fee, 0);
        assertEq(fee, hook.quoteFee(netOutput + fee));
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), fee);
        assertEq(MockERC20(Currency.unwrap(cashAsset)).balanceOf(beneficiary), 0);
    }

    function test_exactOutputAccruesCashAssetInput() public {
        BalanceDelta delta = swap(poolKey, false, 1e10, ZERO_BYTES);
        uint256 netInput = uint256(-int256(delta.amount1()));
        uint256 fee = hook.revenueAvailable();

        assertGt(fee, 0);
        assertEq(fee, hook.quoteFee(netInput - fee));
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), fee);
    }

    function test_doesNotChargeWhenUnspecifiedCurrencyIsNotCashAsset() public {
        BalanceDelta delta = swap(poolKey, false, -1e12, ZERO_BYTES);

        assertGt(delta.amount0(), 0);
        assertEq(hook.revenueAvailable(), 0);
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), 0);
    }

    function test_exactOutputDoesNotChargeWhenUnspecifiedCurrencyIsNotCashAsset() public {
        BalanceDelta delta = swap(poolKey, true, 1e10, ZERO_BYTES);

        assertLt(delta.amount0(), 0);
        assertEq(hook.revenueAvailable(), 0);
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), 0);
    }

    function test_roundsSubBasisPointRevenueDownToZero() public {
        BalanceDelta delta = swap(poolKey, true, -100, ZERO_BYTES);

        assertGt(delta.amount1(), 0);
        assertEq(hook.revenueAvailable(), 0);
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), 0);
    }

    function test_flushIsPermissionlessAndCannotRedirectRevenue() public {
        swap(poolKey, true, -1e12, ZERO_BYTES);
        uint256 amount = hook.revenueAvailable();
        address caller = makeAddr("caller");

        vm.prank(caller);
        uint256 flushed = hook.flushRevenue();

        assertEq(flushed, amount);
        assertEq(hook.revenueAvailable(), 0);
        assertEq(manager.balanceOf(address(hook), cashAsset.toId()), 0);
        assertEq(MockERC20(Currency.unwrap(cashAsset)).balanceOf(beneficiary), amount);
        assertEq(MockERC20(Currency.unwrap(cashAsset)).balanceOf(caller), 0);
    }

    function test_multipleSwapsConserveAccruedClaims() public {
        for (uint256 i; i < 7; ++i) {
            swap(poolKey, true, -int256(1e10 * (i + 1)), ZERO_BYTES);
            assertEq(hook.revenueAvailable(), manager.balanceOf(address(hook), cashAsset.toId()));
        }
    }

    function test_flushRevertsWhenNothingAccrued() public {
        vm.expectRevert(PeerCashRevenueHook.NoRevenueAvailable.selector);
        hook.flushRevenue();
    }

    function test_unlockCallbackRejectsNonPoolManager() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(1));
    }

    function test_constructorRejectsZeroCashAsset() public {
        vm.expectRevert(PeerCashRevenueHook.InvalidCashAsset.selector);
        deployCodeTo(
            "PeerCashRevenueHook.sol:PeerCashRevenueHook",
            abi.encode(manager, Currency.wrap(address(0)), beneficiary, FEE_BPS),
            validHookAddress("zero-cash-asset")
        );
    }

    function test_constructorRejectsZeroBeneficiary() public {
        vm.expectRevert(PeerCashRevenueHook.InvalidBeneficiary.selector);
        deployCodeTo(
            "PeerCashRevenueHook.sol:PeerCashRevenueHook",
            abi.encode(manager, cashAsset, address(0), FEE_BPS),
            validHookAddress("zero-beneficiary")
        );
    }

    function test_constructorRejectsFeeOutsideBounds() public {
        vm.expectRevert(abi.encodeWithSelector(PeerCashRevenueHook.InvalidFeeBps.selector, 0));
        deployCodeTo(
            "PeerCashRevenueHook.sol:PeerCashRevenueHook",
            abi.encode(manager, cashAsset, beneficiary, 0),
            validHookAddress("zero-fee")
        );

        vm.expectRevert(abi.encodeWithSelector(PeerCashRevenueHook.InvalidFeeBps.selector, 101));
        deployCodeTo(
            "PeerCashRevenueHook.sol:PeerCashRevenueHook",
            abi.encode(manager, cashAsset, beneficiary, 101),
            validHookAddress("excess-fee")
        );
    }

    function testFuzz_quoteFeeIsBounded(
        uint128 grossAmount
    ) public view {
        uint256 fee = hook.quoteFee(grossAmount);

        assertLe(fee, uint256(grossAmount) / 100);
        assertLe(fee, grossAmount);
    }

    function validHookAddress(
        string memory salt
    ) internal pure returns (address) {
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        uint160 namespace = uint160(uint256(keccak256(bytes(salt)))) & ~Hooks.ALL_HOOK_MASK;
        return address(namespace | flags);
    }
}
