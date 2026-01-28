//! Shared utilities for WASM modules
//!
//! Contains RPC communication, logging, and common data structures.

use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

// ============================================================================
// WASM Memory Exports (required by host)
// ============================================================================

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let layout = Layout::from_size_align(len as usize, 1).unwrap();
    unsafe { std_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        let layout = Layout::from_size_align(len as usize, 1).unwrap();
        unsafe { std_dealloc(ptr, layout) };
    }
}

// ============================================================================
// Logging Macros
// ============================================================================

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[WASM INFO] {}", format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        eprintln!("[WASM ERROR] {}", format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        eprintln!("[WASM DEBUG] {}", format!($($arg)*));
    };
}

// ============================================================================
// RPC Communication Layer
// ============================================================================

/// RPC configuration from environment
pub struct RpcConfig {
    pub work_dir: String,
    pub request_file: String,
    pub response_file: String,
}

impl RpcConfig {
    /// Load RPC config from environment variables
    pub fn from_env() -> Result<Self, String> {
        let work_dir = env::var("WASM_RPC_WORK_DIR")
            .map_err(|_| "WASM_RPC_WORK_DIR not set")?;
        let request_file = env::var("WASM_RPC_REQUEST_FILE")
            .unwrap_or_else(|_| "wasm_rpc_request.json".to_string());
        let response_file = env::var("WASM_RPC_RESPONSE_FILE")
            .unwrap_or_else(|_| "wasm_rpc_response.json".to_string());

        log_info!("RPC config: work_dir={}, req={}, resp={}",
            work_dir, request_file, response_file);

        Ok(Self { work_dir, request_file, response_file })
    }

    pub fn request_path(&self) -> PathBuf {
        PathBuf::from(&self.work_dir).join(&self.request_file)
    }

    pub fn response_path(&self) -> PathBuf {
        PathBuf::from(&self.work_dir).join(&self.response_file)
    }
}

/// Make an RPC call to the host
pub fn rpc_call(config: &RpcConfig, request: &Value) -> Result<Value, String> {
    let request_str = request.to_string();
    let request_path = config.request_path();
    let response_path = config.response_path();

    log_debug!("RPC request: {}", &request_str[..request_str.len().min(200)]);

    // Write request file
    fs::write(&request_path, &request_str)
        .map_err(|e| format!("Failed to write request to {:?}: {}", request_path, e))?;

    log_info!("RPC request written, polling for response...");

    // Poll for response with timeout
    let poll_interval = Duration::from_millis(10);
    let max_wait = Duration::from_secs(10);
    let mut elapsed = Duration::ZERO;

    while elapsed < max_wait {
        if response_path.exists() {
            let response_str = fs::read_to_string(&response_path)
                .map_err(|e| format!("Failed to read response: {}", e))?;

            log_info!("RPC response received after {}ms", elapsed.as_millis());

            // Clean up files
            let _ = fs::remove_file(&request_path);
            let _ = fs::remove_file(&response_path);

            // Parse JSON response
            let response: Value = serde_json::from_str(&response_str)
                .map_err(|e| format!("Failed to parse RPC response: {}", e))?;

            // Check for RPC error
            if let Some(error) = response.get("error") {
                return Err(format!("RPC error: {}", error));
            }

            return Ok(response);
        }

        thread::sleep(poll_interval);
        elapsed += poll_interval;
    }

    // Timeout
    let _ = fs::remove_file(&request_path);
    Err(format!("RPC call timeout after {}s", max_wait.as_secs()))
}

// ============================================================================
// Protocol Type Constants
// ============================================================================

pub const PROTO_UNKNOWN: u8 = 0;
pub const PROTO_AAVE: u8 = 1;
pub const PROTO_SPARK: u8 = 2;
pub const PROTO_FLUID: u8 = 3;
pub const PROTO_MORPHO: u8 = 4;

// ============================================================================
// Output Helpers
// ============================================================================

/// Output success result with skip flag
pub fn output_success(result: Value) {
    println!("{}", json!({
        "ok": true,
        "result": result
    }));
}

/// Output success result with skip remaining steps flag
pub fn output_skip(message: &str) {
    println!("{}", json!({
        "ok": true,
        "result": {
            "ok": true,
            "success": true,
            "skipRemainingSteps": true,
            "message": message
        }
    }));
}

/// Output error result
pub fn output_error(error: &str) {
    log_error!("{}", error);
    println!("{}", json!({
        "ok": false,
        "result": {
            "ok": false,
            "success": false,
            "error": error
        }
    }));
}
