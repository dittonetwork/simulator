//! Emergency Monitor Module
//!
//! Monitors guard state and decides whether to activate emergency mode.
//!
//! Flow:
//! 1. Check GuardManager.isEmergencyMode() - skip if already active
//! 2. Check GuardManager.getGuardsStaleness() - skip if any guard is stale
//! 3. Check GuardManager.getAggregatedStatus() - skip if NORMAL
//! 4. If status is CAUTION/EMERGENCY with fresh data, proceed to activate
//!
//! Uses skipRemainingSteps to avoid executing contract calls when no action needed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ethabi::{decode, Token, ParamType, Function, Param};
use ethereum_types::Address;

use crate::common::{RpcConfig, rpc_call, output_success, output_skip, output_error};
use crate::{log_info, log_error, log_debug};

// ============================================================================
// Constants
// ============================================================================

/// Guard status constants (from GuardManager contract)
const GUARD_STATUS_NORMAL: u8 = 0;

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyInput {
    /// GuardManager contract address
    pub guard_manager: String,
    /// Vault address (for context)
    pub vault: String,
    /// Chain ID
    pub chain_id: u64,
    /// Action type: "check" (default), "activate", "status"
    #[serde(default = "default_action")]
    pub action: String,
}

fn default_action() -> String {
    "check".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyResult {
    /// Whether emergency mode should be activated
    pub should_activate: bool,
    /// Current aggregated status (0=NORMAL, 1=CAUTION, 2=EMERGENCY)
    pub aggregated_status: u8,
    /// Whether already in emergency mode
    pub is_emergency_mode: bool,
    /// Guard data freshness check passed
    pub data_fresh: bool,
    /// Message explaining the decision
    pub message: String,
}

/// Guard staleness info from getGuardsStaleness()
#[derive(Debug)]
struct GuardStalenessInfo {
    guard: Address,
    enabled: bool,
    updated_at: u64,
    is_stale: bool,
}

// ============================================================================
// RPC Helpers for GuardManager
// ============================================================================

/// Call GuardManager.isEmergencyMode() -> bool
fn is_emergency_mode(rpc_config: &RpcConfig, guard_manager: &str, chain_id: u64) -> Result<bool, String> {
    log_info!("Checking emergency mode status");

    let function = Function {
        name: "isEmergencyMode".to_string(),
        inputs: vec![],
        outputs: vec![Param { name: "".to_string(), kind: ParamType::Bool, internal_type: None }],
        constant: None,
        state_mutability: ethabi::StateMutability::View,
    };

    let call_data = function.encode_input(&[])
        .map_err(|e| format!("Failed to encode isEmergencyMode: {}", e))?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "chainId": chain_id,
        "params": [{
            "to": guard_manager,
            "data": format!("0x{}", hex::encode(&call_data))
        }, "latest"]
    });

    let response = rpc_call(rpc_config, &request)?;

    let result_hex = response.get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No result in isEmergencyMode response".to_string())?;

    let hex_clean = result_hex.strip_prefix("0x").unwrap_or(result_hex);
    let bytes = hex::decode(hex_clean)
        .map_err(|e| format!("Failed to decode hex: {}", e))?;

    let tokens = decode(&[ParamType::Bool], &bytes)
        .map_err(|e| format!("Failed to decode bool: {}", e))?;

    match &tokens[0] {
        Token::Bool(b) => Ok(*b),
        _ => Err("Invalid bool token".to_string()),
    }
}

/// Call GuardManager.getGuardsStaleness() -> GuardStalenessInfo[]
/// Returns (guard, enabled, updatedAt, isStale) for each guard
fn get_guards_staleness(rpc_config: &RpcConfig, guard_manager: &str, chain_id: u64) -> Result<Vec<GuardStalenessInfo>, String> {
    log_info!("Fetching guards staleness info");

    let function = Function {
        name: "getGuardsStaleness".to_string(),
        inputs: vec![],
        outputs: vec![Param {
            name: "info".to_string(),
            kind: ParamType::Array(Box::new(ParamType::Tuple(vec![
                ParamType::Address,    // guard
                ParamType::Bool,       // enabled
                ParamType::Uint(48),   // updatedAt
                ParamType::Bool,       // isStale
            ]))),
            internal_type: None,
        }],
        constant: None,
        state_mutability: ethabi::StateMutability::View,
    };

    let call_data = function.encode_input(&[])
        .map_err(|e| format!("Failed to encode getGuardsStaleness: {}", e))?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "chainId": chain_id,
        "params": [{
            "to": guard_manager,
            "data": format!("0x{}", hex::encode(&call_data))
        }, "latest"]
    });

    let response = rpc_call(rpc_config, &request)?;

    let result_hex = response.get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No result in getGuardsStaleness response".to_string())?;

    let hex_clean = result_hex.strip_prefix("0x").unwrap_or(result_hex);
    let bytes = hex::decode(hex_clean)
        .map_err(|e| format!("Failed to decode hex: {}", e))?;

    let tokens = decode(&[ParamType::Array(Box::new(ParamType::Tuple(vec![
        ParamType::Address,
        ParamType::Bool,
        ParamType::Uint(48),
        ParamType::Bool,
    ])))], &bytes)
        .map_err(|e| format!("Failed to decode guards staleness: {}", e))?;

    let arr = match &tokens[0] {
        Token::Array(a) => a,
        _ => return Err("Invalid array token".to_string()),
    };

    let mut result = Vec::new();
    for item in arr {
        let tuple = match item {
            Token::Tuple(t) => t,
            _ => return Err("Invalid tuple token".to_string()),
        };

        if tuple.len() != 4 {
            return Err(format!("Expected 4 fields in tuple, got {}", tuple.len()));
        }

        let guard = match &tuple[0] {
            Token::Address(a) => *a,
            _ => return Err("Invalid guard address".to_string()),
        };

        let enabled = match &tuple[1] {
            Token::Bool(b) => *b,
            _ => return Err("Invalid enabled bool".to_string()),
        };

        let updated_at = match &tuple[2] {
            Token::Uint(u) => u.as_u64(),
            _ => return Err("Invalid updatedAt".to_string()),
        };

        let is_stale = match &tuple[3] {
            Token::Bool(b) => *b,
            _ => return Err("Invalid isStale bool".to_string()),
        };

        result.push(GuardStalenessInfo { guard, enabled, updated_at, is_stale });
    }

    Ok(result)
}

/// Call GuardManager.getAggregatedStatus() -> uint8
/// NOTE: This reverts if any guard is stale!
fn get_aggregated_status(rpc_config: &RpcConfig, guard_manager: &str, chain_id: u64) -> Result<u8, String> {
    log_info!("Fetching aggregated guard status");

    let function = Function {
        name: "getAggregatedStatus".to_string(),
        inputs: vec![],
        outputs: vec![Param { name: "".to_string(), kind: ParamType::Uint(8), internal_type: None }],
        constant: None,
        state_mutability: ethabi::StateMutability::View,
    };

    let call_data = function.encode_input(&[])
        .map_err(|e| format!("Failed to encode getAggregatedStatus: {}", e))?;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "chainId": chain_id,
        "params": [{
            "to": guard_manager,
            "data": format!("0x{}", hex::encode(&call_data))
        }, "latest"]
    });

    let response = rpc_call(rpc_config, &request)?;

    let result_hex = response.get("result")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No result in getAggregatedStatus response".to_string())?;

    let hex_clean = result_hex.strip_prefix("0x").unwrap_or(result_hex);
    let bytes = hex::decode(hex_clean)
        .map_err(|e| format!("Failed to decode hex: {}", e))?;

    let tokens = decode(&[ParamType::Uint(8)], &bytes)
        .map_err(|e| format!("Failed to decode status: {}", e))?;

    match &tokens[0] {
        Token::Uint(u) => Ok(u.as_u32() as u8),
        _ => Err("Invalid status token".to_string()),
    }
}

// ============================================================================
// Main Logic
// ============================================================================

/// Check if emergency mode should be activated
fn check_emergency_status(
    rpc_config: &RpcConfig,
    guard_manager: &str,
    chain_id: u64,
) -> Result<EmergencyResult, String> {
    // 1. Check if already in emergency mode
    let in_emergency = is_emergency_mode(rpc_config, guard_manager, chain_id)?;
    if in_emergency {
        log_info!("Already in emergency mode");
        return Ok(EmergencyResult {
            should_activate: false,
            aggregated_status: 2, // EMERGENCY
            is_emergency_mode: true,
            data_fresh: true,
            message: "Already in emergency mode".to_string(),
        });
    }

    // 2. Check guards staleness - this doesn't revert
    let guards_info = get_guards_staleness(rpc_config, guard_manager, chain_id)?;

    // Check if any enabled guard is stale
    let stale_guards: Vec<_> = guards_info.iter()
        .filter(|g| g.enabled && g.is_stale)
        .collect();

    if !stale_guards.is_empty() {
        let stale_count = stale_guards.len();
        let total_enabled = guards_info.iter().filter(|g| g.enabled).count();
        log_info!("{}/{} enabled guards are stale - need to run guard-updates workflow first", stale_count, total_enabled);

        return Ok(EmergencyResult {
            should_activate: false,
            aggregated_status: 0, // Unknown - can't check due to staleness
            is_emergency_mode: false,
            data_fresh: false,
            message: format!("{}/{} guards are stale. Run guard-updates workflow first.", stale_count, total_enabled),
        });
    }

    log_info!("All enabled guards have fresh data");

    // 3. Get aggregated status - should work now since guards are fresh
    let status = match get_aggregated_status(rpc_config, guard_manager, chain_id) {
        Ok(s) => s,
        Err(e) => {
            log_error!("Failed to get aggregated status even with fresh guards: {}", e);
            return Ok(EmergencyResult {
                should_activate: false,
                aggregated_status: 0,
                is_emergency_mode: false,
                data_fresh: true,
                message: format!("Failed to get guard status: {}", e),
            });
        }
    };

    log_info!("Aggregated guard status: {}", status);

    // 4. Decide based on status
    if status == GUARD_STATUS_NORMAL {
        log_info!("Guards are normal, no action needed");
        return Ok(EmergencyResult {
            should_activate: false,
            aggregated_status: status,
            is_emergency_mode: false,
            data_fresh: true,
            message: "All guards normal, no action needed".to_string(),
        });
    }

    // Status is CAUTION (1) or higher - should activate emergency mode
    log_info!("Guards triggered (status={}), should activate emergency mode", status);

    Ok(EmergencyResult {
        should_activate: true,
        aggregated_status: status,
        is_emergency_mode: false,
        data_fresh: true,
        message: format!("Guard(s) triggered (status={}), activating emergency mode", status),
    })
}

// ============================================================================
// Entry Point
// ============================================================================

/// Main entry point for emergency monitor
pub fn run(input: Value) {
    log_info!("Running emergency monitor");

    // Parse input
    let emergency_input: EmergencyInput = match serde_json::from_value(input.clone()) {
        Ok(v) => v,
        Err(e) => {
            output_error(&format!("Invalid input JSON: {}", e));
            return;
        }
    };

    log_info!("Config: guardManager={}, vault={}, chainId={}",
        emergency_input.guard_manager,
        emergency_input.vault,
        emergency_input.chain_id);

    // Initialize RPC
    let rpc_config = match RpcConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            output_error(&e);
            return;
        }
    };

    // Check emergency status
    let result = match check_emergency_status(&rpc_config, &emergency_input.guard_manager, emergency_input.chain_id) {
        Ok(r) => r,
        Err(e) => {
            output_error(&format!("Failed to check emergency status: {}", e));
            return;
        }
    };

    // Output result based on decision
    if result.should_activate {
        // Action needed - continue to next step (activateEmergencyMode)
        log_info!("Emergency action needed: {}", result.message);
        output_success(json!({
            "ok": true,
            "success": true,
            "shouldActivate": result.should_activate,
            "aggregatedStatus": result.aggregated_status,
            "isEmergencyMode": result.is_emergency_mode,
            "dataFresh": result.data_fresh,
            "message": result.message,
        }));
    } else {
        // No action needed - skip remaining steps
        log_info!("No emergency action needed: {}", result.message);
        output_skip(&result.message);
    }

    log_info!("Emergency monitor finished");
}
