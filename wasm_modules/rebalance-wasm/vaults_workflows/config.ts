/**
 * Vault Automation Configuration
 *
 * Shared configuration for all vault automation workflows.
 * Update these addresses after deployment.
 */

import { mainnet } from 'viem/chains';

// ============ Chain Configuration ============

export const MAINNET_CHAIN_ID = mainnet.id;

// ============ Mainnet Contract Addresses ============

// Core Vault Contracts
export const VAULT_ADDRESS = '0xa1d1f4233dc8c792f5baea954e2f236bee6dd965'; // YieldSplitVault proxy
export const GUARD_MANAGER_ADDRESS = '0x8b07d38ed03e909a673d0cd59a27615d9eee8520'; // GuardManager proxy
export const RETURN_ESTIMATOR_ADDRESS = '0xc7a88e1b39f38ef838a6e8cf7e211d0aae90cc81'; // ReturnEstimator proxy
export const REBALANCER_ADDRESS = '0xf3ef2a5d993cd958d1e6072d2612504124e28848'; // Rebalancer
export const VAULT_DATA_READER_ADDRESS = '0xf9f69D1bA1007A34bDAdAc55879AC406A3e38250'; // Deployed

// Protocol Pool Addresses
export const AAVE_POOL_ADDRESS = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
export const SPARK_POOL_ADDRESS = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987';
export const FLUID_FUSDC_ADDRESS = '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33';
export const MORPHO_GAUNTLET_ADDRESS = '0xdd0f28e19C1780eb6396170735D45153D261490d';
export const MORPHO_STEAKHOUSE_ADDRESS = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB';

// Adapter Addresses (set after deployment)
export const AAVE_ADAPTER_ADDRESS = '0x5f73a0d132c7ab00350e6a05c9eb1b369d4e57a8';
export const SPARK_ADAPTER_ADDRESS = '0x545fad2c30017f0e3e42afcf9283273c9df8fc05';
export const FLUID_ADAPTER_ADDRESS = '0x6a00de32d7a81af3021d439ea3725eeece3c7184';
export const MORPHO_GAUNTLET_ADAPTER_ADDRESS = '0x20a455051f5d373fd2017c525a792ac0f7b42bbf';
export const MORPHO_STEAKHOUSE_ADAPTER_ADDRESS = '0xe59bbd86260b19cb8b367011d0a384bc81aadd24';

// Estimator Addresses (set after deployment)
export const AAVE_ESTIMATOR_ADDRESS = '0x54cd256e129959a8ee5ec5a8d6f80f67f0d47adc';
export const SPARK_ESTIMATOR_ADDRESS = '0x059888375be78ef15d6aeeda32e06ad56c088153';
export const FLUID_ESTIMATOR_ADDRESS = '0xdc2f0380e0d82f234abe3e4d418a2df15a0d9ff9';
export const MORPHO_GAUNTLET_ESTIMATOR_ADDRESS = '0x6d3ab6d88e0c0741620c4460453c12a7ac33b4bc';
export const MORPHO_STEAKHOUSE_ESTIMATOR_ADDRESS = '0xf1ba2f9ac5144c85cec79bb8d6bcc58743b62515';

// Guard Addresses
export const CHAINLINK_PRICE_GUARD_ADDRESS = '0xb1d712eb1c52a57696c41686a6ff41e93f6a34ec';
export const PROTOCOL_BLOCKLIST_GUARD_ADDRESS = '0xF537D9E3C3dfeeAB4aC78eeFc8e68e078229E8Bc';

export const ALL_GUARD_ADDRESSES = [
  CHAINLINK_PRICE_GUARD_ADDRESS,
  PROTOCOL_BLOCKLIST_GUARD_ADDRESS,
];

// Asset
export const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// ============ Protocol Types ============

export enum ProtocolType {
  Unknown = 0,
  AaveV3 = 1,
  Spark = 2,
  Fluid = 3,
  MetaMorpho = 4,
}

// Order must match on-chain adapter order!
// [0] AaveAdapter, [1] FluidAdapter, [2] MorphoAdapter (Gauntlet), [3] MorphoAdapter (Steakhouse), [4] AaveAdapter (Spark)
export const PROTOCOL_TYPES = [
  ProtocolType.AaveV3,      // [0] Aave
  ProtocolType.Fluid,       // [1] Fluid
  ProtocolType.MetaMorpho,  // [2] Morpho Gauntlet
  ProtocolType.MetaMorpho,  // [3] Morpho Steakhouse
  ProtocolType.Spark,       // [4] Spark
];

export const POOL_ADDRESSES = [
  AAVE_POOL_ADDRESS,        // [0] Aave
  FLUID_FUSDC_ADDRESS,      // [1] Fluid
  MORPHO_GAUNTLET_ADDRESS,  // [2] Morpho Gauntlet
  MORPHO_STEAKHOUSE_ADDRESS,// [3] Morpho Steakhouse
  SPARK_POOL_ADDRESS,       // [4] Spark
];

// ============ Timing Configuration ============

export const GUARD_UPDATE_INTERVAL = '*/30 * * * *'; // Every 30 minutes
export const REBALANCE_INTERVAL = '0 */12 * * *'; // Every 12 hours
export const TIMEPOINT_INTERVAL = '0 */2 * * *'; // Every 2 hours
export const EMERGENCY_CHECK_INTERVAL = '*/5 * * * *'; // Every 5 minutes

// ============ ABIs ============

export const VAULT_ABI = [
  'function executeRebalance(uint256[] calldata targetWeights) external',
  'function emergencyRebalance(uint256[] calldata targetWeights) external',
  'function getLastRebalanceTime() external view returns (uint48)',
  'function getTargetWeights() external view returns (uint256[])',
  'function getAdapters() external view returns (address[])',
  'function getGuardManager() external view returns (address)',
  'function totalAssets() external view returns (uint256)',
  'function executeGuardedEmergencyWithdraw() external returns (uint256)',
];

export const GUARD_MANAGER_ABI = [
  'function updateSingleGuard(address guard) external',
  'function isEmergencyMode() external view returns (bool)',
  'function activateEmergencyMode() external returns (uint8 mask, bool withdrawAll)',
  'function deactivateEmergencyMode() external',
  'function getCachedState() external view returns (uint8 blockedMask, bool emergencyAll)',
  'function getAggregatedStatus() external view returns (uint8)',
  'function getMaxStaleness() external view returns (uint48)',
  'function getGuardsStaleness() external view returns (tuple(address guard, bool enabled, uint48 updatedAt, bool isStale)[])',
];

export const ESTIMATOR_ABI = [
  'function recordTimepoint() external returns (bool recorded)',
  'function getTimepointCount() external view returns (uint16)',
  'function getTimepointLatest() external view returns (uint48 timestamp, uint128 totalAssets, uint128 totalSupply)',
  'function estimateAPYAfterDelta(int256 delta) external view returns (uint256)',
];

export const VAULT_DATA_READER_ABI = [
  'function getSnapshot(address vault, uint8[] calldata protocolTypes, address[] calldata pools) external view returns (tuple(address asset, uint256 totalAssets, uint256 looseCash, uint256[] targetWeights, uint48 lastRebalanceTime, uint48 rebalanceCooldown, uint48 snapshotTimestamp, tuple(uint8 protocolType, address pool, uint256 ourBalance, uint256 poolTotalSupply, uint256 poolTotalBorrow, uint256 utilizationWad, uint256 currentApyWad, tuple(uint256 kink1Bps, uint256 rateAtKink1Bps, uint256 kink2Bps, uint256 rateAtKink2Bps, uint256 rateAtMaxBps, uint256 reserveFactorBps) irm, uint256 metaTotalAssets, uint256 metaTotalSupply, uint256 metaLastTotalAssets, uint64 metaLastUpdate)[] protocols, tuple(uint8 blockedMask, bool emergencyMode, bool emergencyAll) guardState))',
  'function getSnapshotWithManualAllocations(address vault, uint8[] calldata protocolTypes, address[] calldata pools, uint256[] calldata allocations) external view returns (tuple(address asset, uint256 totalAssets, uint256 looseCash, uint256[] targetWeights, uint48 lastRebalanceTime, uint48 rebalanceCooldown, uint48 snapshotTimestamp, tuple(uint8 protocolType, address pool, uint256 ourBalance, uint256 poolTotalSupply, uint256 poolTotalBorrow, uint256 utilizationWad, uint256 currentApyWad, tuple(uint256 kink1Bps, uint256 rateAtKink1Bps, uint256 kink2Bps, uint256 rateAtKink2Bps, uint256 rateAtMaxBps, uint256 reserveFactorBps) irm, uint256 metaTotalAssets, uint256 metaTotalSupply, uint256 metaLastTotalAssets, uint64 metaLastUpdate)[] protocols, tuple(uint8 blockedMask, bool emergencyMode, bool emergencyAll) guardState))',
];

// ============ Role Hashes ============

export const PROTOCOL_ADMIN_ROLE = '0x8502233096d909befbda0999bb8ea2f3a6be3c138b9fbf003752a4c8bce86f6c'; // keccak256("PROTOCOL_ADMIN")
export const KEEPER_ROLE = '0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab'; // keccak256("KEEPER_ROLE")
export const OPERATOR_ROLE = '0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929'; // keccak256("OPERATOR_ROLE")

// ============ Constants ============

export const WAD = BigInt('1000000000000000000'); // 1e18
export const BPS = 10000;
export const REBALANCE_COOLDOWN = 12 * 60 * 60; // 12 hours in seconds
export const MAX_STALENESS_DEFAULT = 60 * 60; // 1 hour in seconds
export const EMERGENCY_ACTIVATION_MAX_AGE = 5 * 60; // 5 minutes in seconds
