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
export const VAULT_ADDRESS = '0x62507A876309639096D08E7F77AC9CfB67Df8011'; // YieldSplitVault proxy
export const GUARD_MANAGER_ADDRESS = '0xD8b3208abEF2Be174c54013626f5AAd028dA099D'; // GuardManager proxy
export const RETURN_ESTIMATOR_ADDRESS = '0x7C347eA9b12aD44A7d66341F51349fDa3380B754'; // ReturnEstimator proxy
export const REBALANCER_ADDRESS = '0x5712F60a08e771a73Ac33977611c75Eb5A968aA0'; // Rebalancer
export const VAULT_DATA_READER_ADDRESS = '0xb228c97Ef7c67f2ad49Fe8645e3d7E7b5C5897aa'; // VaultDataReader proxy

// Protocol Pool Addresses
export const AAVE_POOL_ADDRESS = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
export const SPARK_POOL_ADDRESS = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987';
export const FLUID_FUSDC_ADDRESS = '0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33';
export const MORPHO_GAUNTLET_ADDRESS = '0xdd0f28e19C1780eb6396170735D45153D261490d';
export const MORPHO_STEAKHOUSE_ADDRESS = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB';

// Adapter Addresses (set after deployment)
export const AAVE_ADAPTER_ADDRESS = '0x6BdbdD613993E1C6FDb47773B40A39a5807cf72D';
export const SPARK_ADAPTER_ADDRESS = '0x15310eCF1197792a4767B168aEF7793dBcfC05bA';
export const FLUID_ADAPTER_ADDRESS = '0x75e9626a062A7e9049c5a9A199137D255733f341';
export const MORPHO_GAUNTLET_ADAPTER_ADDRESS = '0xcb541A3a8B92B941407F4F8C8E83CD88CD760d59';
export const MORPHO_STEAKHOUSE_ADAPTER_ADDRESS = '0x66b343a03aBd88A35111Bed5815341E831E2A2Bb';

// Estimator Addresses (set after deployment)
export const AAVE_ESTIMATOR_ADDRESS = '0x19608f06cf3fEB425b18FFFc638b190C876cBFf9';
export const SPARK_ESTIMATOR_ADDRESS = '0x2D61c45C17672dc5f3F472657733e285c6DD56e5';
export const FLUID_ESTIMATOR_ADDRESS = '0x3d5Be9Fe16B9e5113056Ed873ADEFb2a05dD12C1';
export const MORPHO_GAUNTLET_ESTIMATOR_ADDRESS = '0x24b9cb9bCdf9e7d3d89F45118841d41FfB968f1B';
export const MORPHO_STEAKHOUSE_ESTIMATOR_ADDRESS = '0x274e5Bd1C74fF002023E5Fc3710de4B0b92ADE67';

// Guard Addresses
export const CHAINLINK_PRICE_GUARD_ADDRESS = '0x79CdbAd430Db26BA5b71F4dA6681A53a1a22C94E';
export const PROTOCOL_BLOCKLIST_GUARD_ADDRESS = '0x443D490928912251B26f68d8B1b865e7660E3421';

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
  'function updateAllGuards() external returns (uint8 blockedMask, bool withdrawAll)',
  'function isEmergencyMode() external view returns (bool)',
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
