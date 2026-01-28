//! Rebalance Optimizer Module
//!
//! Implements grid search optimization to find optimal allocations across
//! multiple lending protocols (Aave, Spark, Fluid, MetaMorpho).
//!
//! Algorithm:
//! 1. Generate all weight combinations that sum to 100% (stars-and-bars)
//! 2. Filter by constraints (TVL caps, blocked adapters, min allocation)
//! 3. Calculate APYs using protocol-specific IRM models
//! 4. Calculate expected 12h returns
//! 5. Return optimal allocation

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ethabi::{decode, encode, Token, ParamType, Function, Param};
use ethereum_types::{Address, U256};

use crate::common::{RpcConfig, rpc_call, PROTO_AAVE, PROTO_SPARK, PROTO_FLUID, PROTO_MORPHO, output_success, output_error};
use crate::{log_info, log_error, log_debug};

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Clone)]
pub struct IRMParams {
    pub kink1: f64,
    pub rate_at_kink1: f64,
    pub kink2: f64,
    pub rate_at_kink2: f64,
    pub rate_at_max: f64,
    pub reserve_factor: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolState {
    pub our_balance: f64,
    pub pool_supply: f64,
    pub pool_borrow: f64,
    pub utilization: f64,
    pub current_apy: f64,
    pub is_blocked: bool,
    pub protocol_type: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerConfig {
    #[serde(default = "default_step_pct")]
    pub step_pct: usize,
    #[serde(default = "default_max_pool_share")]
    pub max_pool_share: f64,
    #[serde(default = "default_min_allocation")]
    pub min_allocation: f64,
}

fn default_step_pct() -> usize { 1 }
fn default_max_pool_share() -> f64 { 0.2 }
fn default_min_allocation() -> f64 { 1000.0 }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerInput {
    pub total_assets: f64,
    pub protocols: Vec<ProtocolState>,
    #[serde(default)]
    pub blocked_mask: u8,
    #[serde(default)]
    pub config: Option<OptimizerConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationResult {
    pub allocations: Vec<String>,        // As hex strings for contract (actual amounts)
    pub allocations_decimal: Vec<f64>,   // As decimal for debugging
    pub weights: Vec<String>,            // As hex strings in WAD format (1e18 scale) for executeRebalance
    pub weights_decimal: Vec<f64>,       // As decimal for debugging (0.0-1.0 range)
    pub expected_return_12h: f64,
    pub expected_apy_weighted: f64,
    pub apys: Vec<f64>,
    pub scenarios_evaluated: usize,
    pub time_ms: f64,
}

// ============================================================================
// VaultDataReader Integration
// ============================================================================

mod vault_reader {
    use super::*;

    #[derive(Debug)]
    pub struct VaultSnapshot {
        pub asset: Address,
        pub total_assets: U256,
        pub loose_cash: U256,
        pub target_weights: Vec<U256>,
        pub last_rebalance_time: u64,
        pub rebalance_cooldown: u64,
        pub snapshot_timestamp: u64,
        pub protocols: Vec<ProtocolData>,
        pub guard_state: GuardState,
    }

    #[derive(Debug)]
    pub struct ProtocolData {
        pub protocol_type: u8,
        pub pool: Address,
        pub our_balance: U256,
        pub pool_total_supply: U256,
        pub pool_total_borrow: U256,
        pub utilization_wad: U256,
        pub current_apy_wad: U256,
        pub irm: IRMParamsRaw,
        pub meta_total_assets: U256,
        pub meta_total_supply: U256,
        pub meta_last_total_assets: U256,
        pub meta_last_update: u64,
    }

    #[derive(Debug)]
    pub struct IRMParamsRaw {
        pub kink1_bps: U256,
        pub rate_at_kink1_bps: U256,
        pub kink2_bps: U256,
        pub rate_at_kink2_bps: U256,
        pub rate_at_max_bps: U256,
        pub reserve_factor_bps: U256,
    }

    #[derive(Debug)]
    pub struct GuardState {
        pub blocked_mask: u8,
        pub emergency_mode: bool,
        pub emergency_all: bool,
    }

    /// Call VaultDataReader.getSnapshot() via eth_call
    pub fn get_snapshot(
        rpc_config: &RpcConfig,
        vault_data_reader: &str,
        vault: &str,
        protocol_types: &[u8],
        pools: &[String],
        chain_id: u64,
    ) -> Result<VaultSnapshot, String> {
        log_info!("Fetching vault snapshot via VaultDataReader");

        let call_data = encode_get_snapshot_call(vault, protocol_types, pools)?;
        log_debug!("getSnapshot calldata: {}", call_data);

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "chainId": chain_id,
            "params": [{
                "to": vault_data_reader,
                "data": call_data
            }, "latest"]
        });

        let response = rpc_call(rpc_config, &request)?;

        let result_hex = response.get("result")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "No result in getSnapshot response".to_string())?;

        decode_vault_snapshot(result_hex)
    }

    fn encode_get_snapshot_call(
        vault: &str,
        protocol_types: &[u8],
        pools: &[String],
    ) -> Result<String, String> {
        let vault_addr: Address = vault.parse()
            .map_err(|e| format!("Invalid vault address: {}", e))?;

        let pool_addrs: Result<Vec<Address>, _> = pools.iter()
            .map(|p| p.parse())
            .collect();
        let pool_addrs = pool_addrs
            .map_err(|e| format!("Invalid pool address: {}", e))?;

        let vault_token = Token::Address(vault_addr);
        let types_token = Token::Array(
            protocol_types.iter().map(|&t| Token::Uint(U256::from(t))).collect()
        );
        let pools_token = Token::Array(
            pool_addrs.iter().map(|&a| Token::Address(a)).collect()
        );

        let function = Function {
            name: "getSnapshot".to_string(),
            inputs: vec![
                Param { name: "vault".to_string(), kind: ParamType::Address, internal_type: None },
                Param { name: "protocolTypes".to_string(), kind: ParamType::Array(Box::new(ParamType::Uint(8))), internal_type: None },
                Param { name: "pools".to_string(), kind: ParamType::Array(Box::new(ParamType::Address)), internal_type: None },
            ],
            outputs: vec![],
            constant: None,
            state_mutability: ethabi::StateMutability::View,
        };

        let encoded = function.encode_input(&[vault_token, types_token, pools_token])
            .map_err(|e| format!("Failed to encode calldata: {}", e))?;

        Ok(format!("0x{}", hex::encode(encoded)))
    }

    fn decode_vault_snapshot(hex_str: &str) -> Result<VaultSnapshot, String> {
        let hex_clean = hex_str.strip_prefix("0x").unwrap_or(hex_str);
        let all_bytes = hex::decode(hex_clean)
            .map_err(|e| format!("Failed to decode hex: {}", e))?;

        // Skip the first 32-byte offset pointer (Solidity returns struct with dynamic fields wrapped in offset)
        if all_bytes.len() < 32 {
            return Err(format!("Response too short: {} bytes", all_bytes.len()));
        }
        let bytes = &all_bytes[32..];

        let param_types = vec![
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Array(Box::new(ParamType::Uint(256))),
            ParamType::Uint(48),
            ParamType::Uint(48),
            ParamType::Uint(48),
            ParamType::Array(Box::new(
                ParamType::Tuple(vec![
                    ParamType::Uint(8),
                    ParamType::Address,
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Tuple(vec![
                        ParamType::Uint(256),
                        ParamType::Uint(256),
                        ParamType::Uint(256),
                        ParamType::Uint(256),
                        ParamType::Uint(256),
                        ParamType::Uint(256),
                    ]),
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Uint(256),
                    ParamType::Uint(64),
                ])
            )),
            ParamType::Tuple(vec![
                ParamType::Uint(8),
                ParamType::Bool,
                ParamType::Bool,
            ]),
        ];

        let tokens = decode(&param_types, &bytes)
            .map_err(|e| format!("Failed to decode ABI: {}", e))?;

        parse_snapshot_tokens(&tokens)
    }

    fn parse_snapshot_tokens(tokens: &[Token]) -> Result<VaultSnapshot, String> {
        if tokens.len() != 9 {
            return Err(format!("Expected 9 tokens, got {}", tokens.len()));
        }

        let asset = match &tokens[0] {
            Token::Address(a) => *a,
            _ => return Err("Invalid asset token".to_string()),
        };

        let total_assets = match &tokens[1] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid totalAssets token".to_string()),
        };

        let loose_cash = match &tokens[2] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid looseCash token".to_string()),
        };

        let target_weights = match &tokens[3] {
            Token::Array(arr) => {
                arr.iter().map(|t| match t {
                    Token::Uint(u) => Ok(*u),
                    _ => Err("Invalid weight token".to_string()),
                }).collect::<Result<Vec<_>, _>>()?
            }
            _ => return Err("Invalid targetWeights token".to_string()),
        };

        let last_rebalance_time = match &tokens[4] {
            Token::Uint(u) => u.as_u64(),
            _ => return Err("Invalid lastRebalanceTime token".to_string()),
        };

        let rebalance_cooldown = match &tokens[5] {
            Token::Uint(u) => u.as_u64(),
            _ => return Err("Invalid rebalanceCooldown token".to_string()),
        };

        let snapshot_timestamp = match &tokens[6] {
            Token::Uint(u) => u.as_u64(),
            _ => return Err("Invalid snapshotTimestamp token".to_string()),
        };

        let protocols = match &tokens[7] {
            Token::Array(arr) => {
                arr.iter().map(|t| parse_protocol_token(t)).collect::<Result<Vec<_>, _>>()?
            }
            _ => return Err("Invalid protocols token".to_string()),
        };

        let guard_state = match &tokens[8] {
            Token::Tuple(tuple) => parse_guard_state_token(tuple)?,
            _ => return Err("Invalid guardState token".to_string()),
        };

        Ok(VaultSnapshot {
            asset,
            total_assets,
            loose_cash,
            target_weights,
            last_rebalance_time,
            rebalance_cooldown,
            snapshot_timestamp,
            protocols,
            guard_state,
        })
    }

    fn parse_protocol_token(token: &Token) -> Result<ProtocolData, String> {
        let fields = match token {
            Token::Tuple(t) => t,
            _ => return Err("Expected tuple for ProtocolData".to_string()),
        };

        if fields.len() != 12 {
            return Err(format!("Expected 12 fields in ProtocolData, got {}", fields.len()));
        }

        let protocol_type = match &fields[0] {
            Token::Uint(u) => u.as_u32() as u8,
            _ => return Err("Invalid protocolType".to_string()),
        };

        let pool = match &fields[1] {
            Token::Address(a) => *a,
            _ => return Err("Invalid pool address".to_string()),
        };

        let our_balance = match &fields[2] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid ourBalance".to_string()),
        };

        let pool_total_supply = match &fields[3] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid poolTotalSupply".to_string()),
        };

        let pool_total_borrow = match &fields[4] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid poolTotalBorrow".to_string()),
        };

        let utilization_wad = match &fields[5] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid utilizationWad".to_string()),
        };

        let current_apy_wad = match &fields[6] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid currentApyWad".to_string()),
        };

        let irm = match &fields[7] {
            Token::Tuple(irm_fields) => parse_irm_token(irm_fields)?,
            _ => return Err("Invalid IRM params".to_string()),
        };

        let meta_total_assets = match &fields[8] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid metaTotalAssets".to_string()),
        };

        let meta_total_supply = match &fields[9] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid metaTotalSupply".to_string()),
        };

        let meta_last_total_assets = match &fields[10] {
            Token::Uint(u) => *u,
            _ => return Err("Invalid metaLastTotalAssets".to_string()),
        };

        let meta_last_update = match &fields[11] {
            Token::Uint(u) => u.as_u64(),
            _ => return Err("Invalid metaLastUpdate".to_string()),
        };

        Ok(ProtocolData {
            protocol_type,
            pool,
            our_balance,
            pool_total_supply,
            pool_total_borrow,
            utilization_wad,
            current_apy_wad,
            irm,
            meta_total_assets,
            meta_total_supply,
            meta_last_total_assets,
            meta_last_update,
        })
    }

    fn parse_irm_token(fields: &[Token]) -> Result<IRMParamsRaw, String> {
        if fields.len() != 6 {
            return Err(format!("Expected 6 IRM fields, got {}", fields.len()));
        }

        Ok(IRMParamsRaw {
            kink1_bps: match &fields[0] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid kink1Bps".to_string()),
            },
            rate_at_kink1_bps: match &fields[1] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid rateAtKink1Bps".to_string()),
            },
            kink2_bps: match &fields[2] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid kink2Bps".to_string()),
            },
            rate_at_kink2_bps: match &fields[3] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid rateAtKink2Bps".to_string()),
            },
            rate_at_max_bps: match &fields[4] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid rateAtMaxBps".to_string()),
            },
            reserve_factor_bps: match &fields[5] {
                Token::Uint(u) => *u,
                _ => return Err("Invalid reserveFactorBps".to_string()),
            },
        })
    }

    fn parse_guard_state_token(fields: &[Token]) -> Result<GuardState, String> {
        if fields.len() != 3 {
            return Err(format!("Expected 3 guard state fields, got {}", fields.len()));
        }

        Ok(GuardState {
            blocked_mask: match &fields[0] {
                Token::Uint(u) => u.as_u32() as u8,
                _ => return Err("Invalid blockedMask".to_string()),
            },
            emergency_mode: match &fields[1] {
                Token::Bool(b) => *b,
                _ => return Err("Invalid emergencyMode".to_string()),
            },
            emergency_all: match &fields[2] {
                Token::Bool(b) => *b,
                _ => return Err("Invalid emergencyAll".to_string()),
            },
        })
    }
}

// ============================================================================
// IRM (Interest Rate Model) Functions
// ============================================================================

fn calc_borrow_rate_single_kink(
    util: f64,
    kink1: f64,
    rate_kink1: f64,
    rate_max: f64,
) -> f64 {
    if util <= 0.0 {
        return 0.0;
    }

    if util <= kink1 {
        if kink1 > 0.0 { util * rate_kink1 / kink1 } else { 0.0 }
    } else {
        let excess = util - kink1;
        let remaining = 1.0 - kink1;
        if remaining <= 0.0 { return rate_max; }
        rate_kink1 + (rate_max - rate_kink1) * excess / remaining
    }
}

fn calc_borrow_rate_double_kink(
    util: f64,
    kink1: f64,
    rate_kink1: f64,
    kink2: f64,
    rate_kink2: f64,
    rate_max: f64,
) -> f64 {
    if util <= 0.0 { return 0.0; }

    if util <= kink1 {
        if kink1 > 0.0 { util * rate_kink1 / kink1 } else { 0.0 }
    } else if kink2 > kink1 && util <= kink2 {
        let excess = util - kink1;
        let segment = kink2 - kink1;
        rate_kink1 + (rate_kink2 - rate_kink1) * excess / segment
    } else {
        let effective_kink = if kink2 > kink1 { kink2 } else { kink1 };
        let effective_rate = if kink2 > kink1 { rate_kink2 } else { rate_kink1 };
        let excess = util - effective_kink;
        let remaining = 1.0 - effective_kink;
        if remaining <= 0.0 { return rate_max; }
        effective_rate + (rate_max - effective_rate) * excess / remaining
    }
}

fn calc_supply_rate(borrow_rate: f64, util: f64, reserve_factor: f64) -> f64 {
    borrow_rate * util * (1.0 - reserve_factor)
}

fn calc_new_utilization(pool_supply: f64, pool_borrow: f64, delta: f64) -> f64 {
    let new_supply = pool_supply + delta;
    if new_supply <= 0.0 { return 1.0; }
    f64::min(pool_borrow / new_supply, 1.0)
}

fn calc_dilution_time_delta(last_update: u64, snapshot_timestamp: u64) -> u64 {
    const FALLBACK: u64 = 7 * 24 * 3600;
    const MIN_DELTA: u64 = 3600;
    const MAX_DELTA: u64 = 30 * 24 * 3600;

    if snapshot_timestamp == 0 { return FALLBACK; }
    if last_update == 0 || last_update >= snapshot_timestamp { return FALLBACK; }

    let mut time_delta = snapshot_timestamp - last_update;
    if time_delta < MIN_DELTA { time_delta = MIN_DELTA; }
    if time_delta > MAX_DELTA { time_delta = MAX_DELTA; }
    time_delta
}

fn calc_dilution_current_apy(
    total_assets: f64,
    total_supply: f64,
    last_total_assets: f64,
    last_update: u64,
    snapshot_timestamp: u64,
) -> f64 {
    const DEFAULT_APY: f64 = 0.05;
    const SECONDS_PER_YEAR: f64 = 365.0 * 24.0 * 3600.0;

    if total_supply <= 0.0 || total_assets <= 0.0 { return 0.0; }
    if last_total_assets <= 0.0 { return if last_update == 0 { DEFAULT_APY } else { 0.0 }; }
    if last_total_assets >= total_assets { return 0.0; }
    if snapshot_timestamp == 0 { return DEFAULT_APY; }

    let time_delta = calc_dilution_time_delta(last_update, snapshot_timestamp);
    if time_delta == 0 { return DEFAULT_APY; }

    let growth_rate = (total_assets - last_total_assets) / last_total_assets;
    growth_rate * (SECONDS_PER_YEAR / time_delta as f64)
}

fn calc_metamorpho_apy_after_delta(current_apy: f64, pool_supply: f64, delta: f64) -> f64 {
    let new_supply = pool_supply + delta;
    if new_supply <= 0.0 { return 0.0; }
    current_apy * pool_supply / new_supply
}

fn get_default_irm_params(protocol_type: u8) -> (f64, f64, f64, f64, f64, f64) {
    match protocol_type {
        PROTO_AAVE => (0.90, 0.04, 0.0, 0.0, 0.75, 0.10),
        PROTO_SPARK => (0.90, 0.04, 0.0, 0.0, 0.75, 0.10),
        PROTO_FLUID => (0.93, 0.10, 0.0, 0.0, 0.25, 0.0),
        PROTO_MORPHO => (1.0, 0.05, 0.0, 0.0, 0.05, 0.0),
        _ => (0.90, 0.05, 0.0, 0.0, 0.50, 0.05),
    }
}

fn calc_supply_apy_with_irm(protocol: &ProtocolState, delta: f64, irm: &IRMParams) -> f64 {
    if protocol.protocol_type == PROTO_MORPHO {
        return calc_metamorpho_apy_after_delta(protocol.current_apy, protocol.pool_supply, delta);
    }

    let new_util = calc_new_utilization(protocol.pool_supply, protocol.pool_borrow, delta);
    let borrow_rate = if irm.kink2 > 0.0 && irm.kink2 > irm.kink1 {
        calc_borrow_rate_double_kink(new_util, irm.kink1, irm.rate_at_kink1, irm.kink2, irm.rate_at_kink2, irm.rate_at_max)
    } else {
        calc_borrow_rate_single_kink(new_util, irm.kink1, irm.rate_at_kink1, irm.rate_at_max)
    };

    calc_supply_rate(borrow_rate, new_util, irm.reserve_factor)
}

fn calc_supply_apy(protocol: &ProtocolState, delta: f64) -> f64 {
    if protocol.protocol_type == PROTO_MORPHO {
        return calc_metamorpho_apy_after_delta(protocol.current_apy, protocol.pool_supply, delta);
    }

    let new_util = calc_new_utilization(protocol.pool_supply, protocol.pool_borrow, delta);
    let (kink1, rate_kink1, kink2, rate_kink2, rate_max, reserve_factor) = get_default_irm_params(protocol.protocol_type);

    let borrow_rate = if kink2 > 0.0 && kink2 > kink1 {
        calc_borrow_rate_double_kink(new_util, kink1, rate_kink1, kink2, rate_kink2, rate_max)
    } else {
        calc_borrow_rate_single_kink(new_util, kink1, rate_kink1, rate_max)
    };

    calc_supply_rate(borrow_rate, new_util, reserve_factor)
}

// ============================================================================
// Grid Generation
// ============================================================================

fn generate_weight_grid(n_protocols: usize, step_pct: usize) -> Vec<Vec<f64>> {
    let n_steps = 100 / step_pct;
    let step = 1.0 / n_steps as f64;
    let mut weights = Vec::new();

    fn generate_recursive(
        depth: usize, n_protocols: usize, remaining: usize, step: f64,
        current: &mut Vec<f64>, weights: &mut Vec<Vec<f64>>,
    ) {
        if depth == n_protocols - 1 {
            current.push(remaining as f64 * step);
            weights.push(current.clone());
            current.pop();
            return;
        }

        for w in 0..=remaining {
            current.push(w as f64 * step);
            generate_recursive(depth + 1, n_protocols, remaining - w, step, current, weights);
            current.pop();
        }
    }

    let mut current = Vec::new();
    generate_recursive(0, n_protocols, n_steps, step, &mut current, &mut weights);
    weights
}

fn generate_bounded_weight_grid(n_protocols: usize, step_pct: usize, max_weights_pct: &[usize]) -> Vec<Vec<f64>> {
    let max_steps: Vec<usize> = max_weights_pct.iter()
        .map(|w| (*w / step_pct).min(100 / step_pct))
        .collect();
    let total_steps = 100 / step_pct;
    let mut results = Vec::new();

    fn generate_recursive(
        depth: usize, n_protocols: usize, remaining: usize, step_pct: usize,
        max_steps: &[usize], current: &mut Vec<f64>, results: &mut Vec<Vec<f64>>,
    ) {
        if depth == n_protocols - 1 {
            if remaining <= max_steps[depth] {
                current.push(remaining as f64 * step_pct as f64 / 100.0);
                results.push(current.clone());
                current.pop();
            }
            return;
        }

        let max_for_this = max_steps[depth].min(remaining);
        for w in 0..=max_for_this {
            current.push(w as f64 * step_pct as f64 / 100.0);
            generate_recursive(depth + 1, n_protocols, remaining - w, step_pct, max_steps, current, results);
            current.pop();
        }
    }

    let mut current = Vec::new();
    generate_recursive(0, n_protocols, total_steps, step_pct, &max_steps, &mut current, &mut results);
    results
}

// ============================================================================
// Constraint Filtering
// ============================================================================

fn is_valid_allocation(
    allocations: &[f64],
    protocols: &[ProtocolState],
    blocked_mask: u8,
    max_pool_share: f64,
    min_allocation: f64,
) -> bool {
    for (i, &alloc) in allocations.iter().enumerate() {
        let protocol = &protocols[i];

        let is_blocked = (blocked_mask & (1 << i)) != 0;
        if is_blocked && alloc > protocol.our_balance {
            return false;
        }

        let delta = alloc - protocol.our_balance;
        let new_pool_supply = protocol.pool_supply + delta;
        if new_pool_supply > 0.0 && alloc > new_pool_supply * max_pool_share {
            return false;
        }

        if alloc > 0.0 && alloc < min_allocation {
            return false;
        }
    }

    true
}

// ============================================================================
// Optimizer
// ============================================================================

fn optimize(
    total_assets: f64,
    protocols: &[ProtocolState],
    blocked_mask: u8,
    config: &OptimizerConfig,
    irm_params: Option<&[IRMParams]>,
) -> Result<OptimizationResult, String> {
    let start_time = std::time::Instant::now();
    let n_protocols = protocols.len();

    log_info!("Starting optimization for {} protocols with {}% step", n_protocols, config.step_pct);
    log_info!("Total assets: {:.2}", total_assets);

    let use_bounded_grid = total_assets > 0.0;
    let weights = if use_bounded_grid {
        let max_allocs: Vec<f64> = protocols.iter()
            .map(|p| p.pool_supply * config.max_pool_share / (1.0 - config.max_pool_share))
            .collect();

        let mut max_weights_pct: Vec<usize> = max_allocs.iter()
            .map(|ma| ((ma / total_assets * 100.0) as usize + 1).min(100))
            .collect();

        let current_balances: Vec<f64> = protocols.iter().map(|p| p.our_balance).collect();
        for i in 0..n_protocols {
            if (blocked_mask & (1 << i)) != 0 {
                max_weights_pct[i] = ((current_balances[i] / total_assets * 100.0) as usize).max(0);
            }
        }

        log_info!("Using bounded grid with max weights: {:?}", max_weights_pct);
        let w = generate_bounded_weight_grid(n_protocols, config.step_pct, &max_weights_pct);
        log_info!("Generated {} bounded combinations", w.len());
        w
    } else {
        let w = generate_weight_grid(n_protocols, config.step_pct);
        log_info!("Generated {} full combinations", w.len());
        w
    };

    let n_scenarios = weights.len();
    log_info!("Evaluating {} scenarios...", n_scenarios);

    if n_scenarios == 0 {
        return Err("No valid weight combinations generated".to_string());
    }

    let mut best_return = f64::NEG_INFINITY;
    let mut best_allocations: Option<Vec<f64>> = None;
    let mut best_apys: Option<Vec<f64>> = None;
    let mut valid_count = 0;

    for weight_combo in weights.iter() {
        let allocations: Vec<f64> = weight_combo.iter().map(|&w| w * total_assets).collect();

        if !is_valid_allocation(&allocations, protocols, blocked_mask, config.max_pool_share, config.min_allocation) {
            continue;
        }

        valid_count += 1;

        let apys: Vec<f64> = if let Some(irm_params_slice) = irm_params {
            allocations.iter().zip(protocols.iter()).zip(irm_params_slice.iter())
                .map(|((&alloc, protocol), irm)| {
                    let delta = alloc - protocol.our_balance;
                    calc_supply_apy_with_irm(protocol, delta, irm)
                })
                .collect()
        } else {
            allocations.iter().zip(protocols.iter())
                .map(|(&alloc, protocol)| {
                    let delta = alloc - protocol.our_balance;
                    calc_supply_apy(protocol, delta)
                })
                .collect()
        };

        let time_factor = 12.0 / 8760.0;
        let return_12h: f64 = allocations.iter().zip(apys.iter())
            .map(|(&alloc, &apy)| alloc * apy * time_factor)
            .sum();

        if return_12h > best_return {
            best_return = return_12h;
            best_allocations = Some(allocations);
            best_apys = Some(apys);
        }
    }

    log_info!("Valid scenarios: {} ({:.1}%)", valid_count, 100.0 * valid_count as f64 / n_scenarios as f64);

    if let (Some(allocations), Some(apys)) = (best_allocations, best_apys) {
        let weights: Vec<f64> = if total_assets > 0.0 {
            allocations.iter().map(|&a| a / total_assets).collect()
        } else {
            vec![0.0; n_protocols]
        };

        let weighted_apy = if total_assets > 0.0 {
            allocations.iter().zip(apys.iter()).map(|(&a, &apy)| a * apy).sum::<f64>() / total_assets
        } else {
            0.0
        };

        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;

        let allocations_hex: Vec<String> = allocations.iter()
            .map(|&a| format!("0x{:064x}", (a as u128).min(u128::MAX)))
            .collect();

        const WAD_F64: f64 = 1e18;
        let weights_wad: Vec<String> = weights.iter()
            .map(|&w| format!("0x{:064x}", (w * WAD_F64) as u128))
            .collect();

        log_info!("Optimization complete: return={:.4}, apy={:.4}%, time={:.2}ms",
            best_return, weighted_apy * 100.0, elapsed_ms);

        Ok(OptimizationResult {
            allocations: allocations_hex,
            allocations_decimal: allocations,
            weights: weights_wad,
            weights_decimal: weights,
            expected_return_12h: best_return,
            expected_apy_weighted: weighted_apy,
            apys,
            scenarios_evaluated: n_scenarios,
            time_ms: elapsed_ms,
        })
    } else {
        // No valid allocation found - return current allocation
        let current_balances: Vec<f64> = protocols.iter().map(|p| p.our_balance).collect();
        let current_apys: Vec<f64> = protocols.iter().map(|p| p.current_apy).collect();
        let weights_decimal: Vec<f64> = if total_assets > 0.0 {
            current_balances.iter().map(|&b| b / total_assets).collect()
        } else {
            vec![0.0; n_protocols]
        };

        let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;

        let allocations_hex: Vec<String> = current_balances.iter()
            .map(|&a| format!("0x{:064x}", (a as u128).min(u128::MAX)))
            .collect();

        const WAD_F64: f64 = 1e18;
        let weights_wad: Vec<String> = weights_decimal.iter()
            .map(|&w| format!("0x{:064x}", (w * WAD_F64) as u128))
            .collect();

        log_info!("No valid allocation found, returning current state");

        Ok(OptimizationResult {
            allocations: allocations_hex,
            allocations_decimal: current_balances,
            weights: weights_wad,
            weights_decimal,
            expected_return_12h: 0.0,
            expected_apy_weighted: 0.0,
            apys: current_apys,
            scenarios_evaluated: n_scenarios,
            time_ms: elapsed_ms,
        })
    }
}

// ============================================================================
// Transform Functions
// ============================================================================

fn transform_snapshot_to_input(snapshot: vault_reader::VaultSnapshot) -> (OptimizerInput, Vec<IRMParams>) {
    const WAD: f64 = 1e18;
    const BPS: f64 = 10000.0;

    let total_assets = snapshot.total_assets.low_u128() as f64;
    let mut protocols: Vec<ProtocolState> = Vec::new();
    let mut irm_params_list: Vec<IRMParams> = Vec::new();

    for p in snapshot.protocols.iter() {
        let current_apy = if p.protocol_type == PROTO_MORPHO {
            calc_dilution_current_apy(
                p.meta_total_assets.low_u128() as f64,
                p.meta_total_supply.low_u128() as f64,
                p.meta_last_total_assets.low_u128() as f64,
                p.meta_last_update,
                snapshot.snapshot_timestamp,
            )
        } else {
            p.current_apy_wad.low_u128() as f64 / WAD
        };

        protocols.push(ProtocolState {
            our_balance: p.our_balance.low_u128() as f64,
            pool_supply: p.pool_total_supply.low_u128() as f64,
            pool_borrow: p.pool_total_borrow.low_u128() as f64,
            utilization: p.utilization_wad.low_u128() as f64 / WAD,
            current_apy,
            is_blocked: false,
            protocol_type: p.protocol_type,
        });

        irm_params_list.push(IRMParams {
            kink1: p.irm.kink1_bps.low_u128() as f64 / BPS,
            rate_at_kink1: p.irm.rate_at_kink1_bps.low_u128() as f64 / BPS,
            kink2: p.irm.kink2_bps.low_u128() as f64 / BPS,
            rate_at_kink2: p.irm.rate_at_kink2_bps.low_u128() as f64 / BPS,
            rate_at_max: p.irm.rate_at_max_bps.low_u128() as f64 / BPS,
            reserve_factor: p.irm.reserve_factor_bps.low_u128() as f64 / BPS,
        });
    }

    let input = OptimizerInput {
        total_assets,
        protocols,
        blocked_mask: snapshot.guard_state.blocked_mask,
        config: None,
    };

    (input, irm_params_list)
}

// ============================================================================
// Entry Points
// ============================================================================

/// RPC-enabled mode: fetch data from VaultDataReader and optimize
pub fn run_with_rpc(input: Value) {
    log_info!("Running rebalance in RPC-enabled mode");

    let vault_data_reader = input.get("vaultDataReader").and_then(|v| v.as_str()).unwrap_or("");
    let vault = input.get("vault").and_then(|v| v.as_str()).unwrap_or("");
    let protocol_types: Vec<u8> = input.get("protocolTypes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect())
        .unwrap_or_default();
    let pools: Vec<String> = input.get("pools")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let chain_id = input.get("chainId").and_then(|v| v.as_u64()).unwrap_or(1);

    log_info!("Config: vault={}, protocols={}, chainId={}", vault, protocol_types.len(), chain_id);

    let rpc_config = match RpcConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            output_error(&e);
            return;
        }
    };

    log_info!("Fetching vault snapshot...");
    let snapshot = match vault_reader::get_snapshot(&rpc_config, vault_data_reader, vault, &protocol_types, &pools, chain_id) {
        Ok(s) => s,
        Err(e) => {
            output_error(&format!("Failed to fetch snapshot: {}", e));
            return;
        }
    };

    log_info!("Snapshot fetched: {} protocols, totalAssets={}", snapshot.protocols.len(), snapshot.total_assets);

    let (optimizer_input, irm_params) = transform_snapshot_to_input(snapshot);
    log_info!("Transformed {} protocols with IRM params", optimizer_input.protocols.len());

    let config = if let Some(cfg) = input.get("config") {
        OptimizerConfig {
            step_pct: cfg.get("stepPct").and_then(|v| v.as_u64()).unwrap_or(1) as usize,
            max_pool_share: cfg.get("maxPoolShare").and_then(|v| v.as_f64()).unwrap_or(0.2),
            min_allocation: cfg.get("minAllocation").and_then(|v| v.as_f64()).unwrap_or(1000.0),
        }
    } else {
        OptimizerConfig { step_pct: 1, max_pool_share: 0.2, min_allocation: 1000.0 }
    };

    match optimize(optimizer_input.total_assets, &optimizer_input.protocols, optimizer_input.blocked_mask, &config, Some(&irm_params)) {
        Ok(result) => {
            log_info!("Optimization successful");
            output_success(json!({
                "ok": true,
                "success": true,
                "value": result.weights,
                "allocations": result.allocations,
                "allocationsDecimal": result.allocations_decimal,
                "weights": result.weights,
                "weightsDecimal": result.weights_decimal,
                "expectedReturn12h": result.expected_return_12h,
                "expectedApyWeighted": result.expected_apy_weighted,
                "apys": result.apys,
                "scenariosEvaluated": result.scenarios_evaluated,
                "timeMs": result.time_ms,
            }));
        }
        Err(e) => output_error(&format!("Optimization failed: {}", e)),
    }
}

/// Legacy mode: use protocol data directly from input
pub fn run_legacy(input: Value) {
    log_info!("Running rebalance in legacy mode (direct protocol data)");

    let optimizer_input: OptimizerInput = match serde_json::from_value(input) {
        Ok(v) => v,
        Err(e) => {
            output_error(&format!("Invalid input JSON: {}", e));
            return;
        }
    };

    let config = optimizer_input.config.unwrap_or(OptimizerConfig {
        step_pct: 1, max_pool_share: 0.2, min_allocation: 1000.0,
    });

    match optimize(optimizer_input.total_assets, &optimizer_input.protocols, optimizer_input.blocked_mask, &config, None) {
        Ok(result) => {
            log_info!("Optimization successful");
            output_success(json!({
                "ok": true,
                "success": true,
                "value": result.weights,
                "allocations": result.allocations,
                "allocationsDecimal": result.allocations_decimal,
                "weights": result.weights,
                "weightsDecimal": result.weights_decimal,
                "expectedReturn12h": result.expected_return_12h,
                "expectedApyWeighted": result.expected_apy_weighted,
                "apys": result.apys,
                "scenariosEvaluated": result.scenarios_evaluated,
                "timeMs": result.time_ms,
            }));
        }
        Err(e) => output_error(&format!("Optimization failed: {}", e)),
    }
}
