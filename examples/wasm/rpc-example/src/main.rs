/**
 * WASM Guest Module with Host RPC Support
 * 
 * This module demonstrates how to call host.rpc_call from guest WASM.
 * 
 * For now, uses a file-based communication protocol (since Wasmtime JS API is limited).
 * In a full Wasmtime implementation, this would use proper host imports.
 */

use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};

// Host import function signature
// In a proper Wasmtime implementation, this would be:
// #[link(wasm_import_module = "host")]
// extern "C" {
//     fn rpc_call(req_ptr: u32, req_len: u32, resp_ptr_ptr: u32) -> u32;
// }

// For file-based protocol, we'll use a helper function
// In production with proper Wasmtime host imports, this would call the imported function directly

/// Allocate memory in WASM module
/// This function is exported and called by the host to allocate response memory
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let layout = Layout::from_size_align(len as usize, 1).unwrap();
    unsafe { std_alloc(layout) }
}

/// Deallocate memory in WASM module
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if !ptr.is_null() {
        let layout = Layout::from_size_align(len as usize, 1).unwrap();
        unsafe { std_dealloc(ptr, layout) };
    }
}

/// Host RPC call helper
/// 
/// In a proper Wasmtime implementation, this would:
/// 1. Call host.rpc_call with request pointer/length
/// 2. Host allocates memory via our alloc() export
/// 3. Host writes response and returns pointer
/// 4. We read response from memory and return it
/// 
/// For now, uses file-based protocol as a workaround.
pub fn host_rpc(req: &str) -> Result<String, String> {
    // File-based protocol implementation
    // Uses WASI pre-opened directories (via --dir flag in wasmtime)
    // The work directory is pre-opened and accessible via its path
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    
    // Get the work directory path from environment
    let work_dir = env::var("WASM_RPC_WORK_DIR")
        .map_err(|_| "WASM_RPC_WORK_DIR not set")?;
    let request_file = env::var("WASM_RPC_REQUEST_FILE")
        .unwrap_or_else(|_| "wasm_rpc_request.json".to_string());
    let response_file = env::var("WASM_RPC_RESPONSE_FILE")
        .unwrap_or_else(|_| "wasm_rpc_response.json".to_string());
    
    // Build paths using the work directory
    let request_path = PathBuf::from(&work_dir).join(&request_file);
    let response_path = PathBuf::from(&work_dir).join(&response_file);
    
    // Write request
    fs::write(&request_path, req)
        .map_err(|e| format!("Failed to write request: {} (path: {:?})", e, request_path))?;
    
    // Poll for response (with timeout)
    let max_wait_ms = 5000;
    let poll_interval_ms = 10;
    let max_iterations = max_wait_ms / poll_interval_ms;
    
    for _ in 0..max_iterations {
        if response_path.exists() {
            // Read response
            let response = fs::read_to_string(&response_path)
                .map_err(|e| format!("Failed to read response: {}", e))?;
            
            // Clean up
            let _ = fs::remove_file(&request_path);
            let _ = fs::remove_file(&response_path);
            
            return Ok(response);
        }
        
        // Sleep (in WASM, we can't sleep, so we just spin)
        // In a real implementation, we'd use proper async/await or host sleep
        for _ in 0..1000 {
            // Spin wait
        }
    }
    
    Err("RPC call timeout".to_string())
}

/// Example run function that demonstrates RPC calls
#[no_mangle]
pub extern "C" fn run() {
    use serde_json::{json, Value};
    
    let mut results = Vec::new();
    
    // Example 1: Call eth_blockNumber
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_blockNumber",
        "params": []
    });
    
    match host_rpc(&request.to_string()) {
        Ok(response) => {
            eprintln!("eth_blockNumber response: {}", response);
            match serde_json::from_str::<Value>(&response) {
                Ok(parsed) => results.push(json!({
                    "method": "eth_blockNumber",
                    "success": true,
                    "response": parsed
                })),
                Err(e) => {
                    eprintln!("Failed to parse response: {}", e);
                    results.push(json!({
                        "method": "eth_blockNumber",
                        "success": false,
                        "error": format!("Parse error: {}", e)
                    }));
                }
            }
        }
        Err(e) => {
            eprintln!("RPC call failed: {}", e);
            results.push(json!({
                "method": "eth_blockNumber",
                "success": false,
                "error": e
            }));
        }
    }
    
    // Example 2: Call eth_getBalance (if address provided)
    // This is just a demonstration - in practice, you'd get the address from input
    let request2 = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "eth_getBalance",
        "params": [
            "0x0000000000000000000000000000000000000000",
            "latest"
        ]
    });
    
    match host_rpc(&request2.to_string()) {
        Ok(response) => {
            eprintln!("eth_getBalance response: {}", response);
            match serde_json::from_str::<Value>(&response) {
                Ok(parsed) => results.push(json!({
                    "method": "eth_getBalance",
                    "success": true,
                    "response": parsed
                })),
                Err(e) => {
                    eprintln!("Failed to parse response: {}", e);
                    results.push(json!({
                        "method": "eth_getBalance",
                        "success": false,
                        "error": format!("Parse error: {}", e)
                    }));
                }
            }
        }
        Err(e) => {
            eprintln!("RPC call failed: {}", e);
            results.push(json!({
                "method": "eth_getBalance",
                "success": false,
                "error": e
            }));
        }
    }
    
    // Output final JSON result to stdout (server expects JSON on stdout)
    let output = json!({
        "ok": true,
        "results": results
    });
    println!("{}", output.to_string());
}

// Note: For WASM, we typically don't use main().
// The run() function is exported and called by the host.
// Main function removed since this is a library (cdylib) for WASM.

