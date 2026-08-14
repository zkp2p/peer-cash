// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title Peer Cash Revenue Hook
/// @notice Collects a bounded fee in Base USDC for later cash-out through Peer Cash.
/// @dev The hook never calls Peer Cash, a curator, or any other external protocol during a
/// swap. Fees stay as PoolManager ERC-6909 claims until anyone flushes them to the immutable
/// beneficiary. That beneficiary then owns the ordinary Peer Cash SDK maker lifecycle.
contract PeerCashRevenueHook is BaseHook, IUnlockCallback {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;
    using SafeCast for int256;
    using SafeCast for uint256;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_FEE_BPS = 100;

    Currency public immutable cashAsset;
    address public immutable beneficiary;
    uint16 public immutable feeBps;

    error InvalidCashAsset();
    error InvalidBeneficiary();
    error InvalidFeeBps(uint256 feeBps);
    error NoRevenueAvailable();

    event RevenueAccrued(
        PoolId indexed poolId, address indexed sender, uint256 feeAmount, uint256 revenueAvailable
    );
    event RevenueFlushed(address indexed caller, address indexed beneficiary, uint256 amount);

    constructor(
        IPoolManager poolManager_,
        Currency cashAsset_,
        address beneficiary_,
        uint16 feeBps_
    ) BaseHook(poolManager_) {
        if (Currency.unwrap(cashAsset_) == address(0)) revert InvalidCashAsset();
        if (beneficiary_ == address(0)) revert InvalidBeneficiary();
        if (feeBps_ == 0 || feeBps_ > MAX_FEE_BPS) revert InvalidFeeBps(feeBps_);

        cashAsset = cashAsset_;
        beneficiary = beneficiary_;
        feeBps = feeBps_;
    }

    /// @notice Returns the fee for a gross unspecified-currency swap amount.
    function quoteFee(
        uint256 grossAmount
    ) public view returns (uint256) {
        return Math.mulDiv(grossAmount, feeBps, BPS_DENOMINATOR);
    }

    /// @notice Cash-asset claims accrued in the PoolManager and not yet flushed.
    function revenueAvailable() public view returns (uint256) {
        return poolManager.balanceOf(address(this), cashAsset.toId());
    }

    /// @notice Redeems all accrued PoolManager claims as cash-asset ERC-20s to the beneficiary.
    /// @dev Permissionless by design: the destination is immutable, so callers can trigger a
    /// flush but can never redirect revenue. A reverted redemption leaves the claims untouched.
    function flushRevenue() external returns (uint256 amount) {
        amount = revenueAvailable();
        if (amount == 0) revert NoRevenueAvailable();

        poolManager.unlock(abi.encode(amount));

        emit RevenueFlushed(msg.sender, beneficiary, amount);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(
        bytes calldata data
    ) external onlyPoolManager returns (bytes memory) {
        uint256 amount = abi.decode(data, (uint256));

        poolManager.burn(address(this), cashAsset.toId(), amount);
        poolManager.take(cashAsset, beneficiary, amount);

        return abi.encode(amount);
    }

    /// @inheritdoc BaseHook
    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory permissions)
    {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        (Currency unspecified, int128 unspecifiedAmount) = (params.amountSpecified < 0
                == params.zeroForOne)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());

        if (Currency.unwrap(unspecified) != Currency.unwrap(cashAsset)) {
            return (this.afterSwap.selector, 0);
        }

        uint256 grossAmount = unspecifiedAmount < 0
            ? (-int256(unspecifiedAmount)).toUint256()
            : int256(unspecifiedAmount).toUint256();
        uint256 feeAmount = quoteFee(grossAmount);
        if (feeAmount == 0) return (this.afterSwap.selector, 0);

        // Claims avoid an ERC-20 transfer and external token call inside the swap callback.
        cashAsset.take(poolManager, address(this), feeAmount, true);
        uint256 available = revenueAvailable();

        emit RevenueAccrued(key.toId(), sender, feeAmount, available);
        return (this.afterSwap.selector, feeAmount.toInt256().toInt128());
    }
}
