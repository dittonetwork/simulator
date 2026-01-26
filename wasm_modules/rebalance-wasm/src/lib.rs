//! WASM Module: Vault Automation
//!
//! This module provides two main functionalities:
//! 1. Rebalance Optimizer - finds optimal allocations across lending protocols
//! 2. Emergency Monitor - checks guard status and activates emergency mode
//!
//! The action is determined by the "action" field in the input JSON:
//! - "rebalance" (default): Run yield optimizer
//! - "emergency-check": Check guard status and activate emergency mode if needed
//!
//! Both modules support the skipRemainingSteps flag to conditionally skip
//! subsequent workflow steps.

#[macro_use]
pub mod common;
pub mod rebalance;
pub mod emergency;

use serde_json::Value;
use std::io::{self, BufRead};

// Re-export memory management functions from common
pub use common::{alloc, dealloc};

// ============================================================================
// Main Entry Point
// ============================================================================

#[no_mangle]
pub extern "C" fn run() {
    log_info!("Vault Automation WASM starting");

    // Read input from stdin
    let stdin = io::stdin();
    let input_line = stdin.lock().lines().next()
        .unwrap_or_else(|| Ok("{}".to_string()))
        .unwrap_or_else(|_| "{}".to_string());

    let input: Value = match serde_json::from_str(&input_line) {
        Ok(v) => v,
        Err(e) => {
            log_error!("Failed to parse input: {}", e);
            common::output_error(&format!("Invalid input: {}", e));
            return;
        }
    };

    // Determine action from input
    let action = input.get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("rebalance");

    log_info!("Action: {}", action);

    match action {
        "rebalance" => {
            // Check if this is RPC-enabled mode (has vaultDataReader field)
            if input.get("vaultDataReader").is_some() {
                rebalance::run_with_rpc(input);
            } else {
                rebalance::run_legacy(input);
            }
        }
        "emergency-check" | "emergency" => {
            emergency::run(input);
        }
        _ => {
            log_error!("Unknown action: {}", action);
            common::output_error(&format!("Unknown action: {}. Valid actions: rebalance, emergency-check", action));
        }
    }

    log_info!("WASM module finished");
}
