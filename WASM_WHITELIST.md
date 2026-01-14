# WASM Execution Whitelist

This document describes the WASM execution whitelist feature that restricts WASM step execution to whitelisted owner addresses.

## Overview

The WASM whitelist feature allows you to control which workflow owners can execute WASM steps. This provides an additional security layer for WASM execution.

## Configuration

### Environment Variables

Add these environment variables to enable and configure the whitelist:

```bash
# Enable WASM whitelist (default: false)
WASM_WHITELIST_ENABLED=true

# Comma-separated list of owner addresses (optional, can also use database)
WASM_WHITELIST_ADDRESSES=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb,0x1234567890123456789012345678901234567890
```

### Database Whitelist Collection

Alternatively, you can store whitelisted addresses in MongoDB:

**Collection:** `wasm_whitelist`

**Document Structure:**
```javascript
{
  "_id": ObjectId("..."),
  "owner": "0x742d35cc6634c0532925a3b844bc9e7595f0beb", // lowercase address
  "enabled": true,
  "createdAt": ISODate("2025-01-15T10:00:00Z"),
  "notes": "Optional description"
}
```

**Example: Add owner to whitelist**
```javascript
db.wasm_whitelist.insertOne({
  owner: "0x742d35cc6634c0532925a3b844bc9e7595f0beb",
  enabled: true,
  createdAt: new Date(),
  notes: "Trusted developer"
});
```

**Example: Remove owner from whitelist**
```javascript
db.wasm_whitelist.updateOne(
  { owner: "0x742d35cc6634c0532925a3b844bc9e7595f0beb" },
  { $set: { enabled: false } }
);
```

## How It Works

1. **Whitelist Check**: Before executing WASM steps, the system checks if the workflow owner is whitelisted.

2. **Whitelist Sources**: The system checks in this order:
   - Environment variable `WASM_WHITELIST_ADDRESSES` (if provided)
   - MongoDB `wasm_whitelist` collection

3. **Behavior**:
   - **If whitelisted**: WASM steps execute normally
   - **If NOT whitelisted**: 
     - WASM steps are skipped
     - Contract steps execute normally
     - Contract steps referencing WASM results will fail with a clear error message

## Example Scenarios

### Scenario 1: Whitelisted Owner

```typescript
// Workflow owner: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
// This address is in WASM_WHITELIST_ADDRESSES or wasm_whitelist collection

// Result:
// ✅ WASM steps execute
// ✅ Contract steps execute
// ✅ WASM references in contract steps resolve correctly
```

### Scenario 2: Non-Whitelisted Owner

```typescript
// Workflow owner: 0x9999999999999999999999999999999999999999
// This address is NOT whitelisted

// Result:
// ⚠️ WASM steps are skipped (logged as warning)
// ✅ Contract steps execute (if they don't reference WASM)
// ❌ Contract steps with WASM references fail with error:
//    "Contract step references WASM result but owner is not whitelisted..."
```

### Scenario 3: Whitelist Disabled

```bash
WASM_WHITELIST_ENABLED=false
# or
# WASM_WHITELIST_ENABLED not set
```

```typescript
// Result:
// ✅ All owners can execute WASM steps
// ✅ No whitelist checks performed
```

## Integration with WASM Updates

The whitelist works with the WASM update tracking system. When a WASM module is updated:

```javascript
{
  "wasm_id": "0x1234...",
  "ipfs_hash": "QmLatestHash...",
  "owner": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "update_history": [...]
}
```

The `owner` field from the WASM update document is checked against the whitelist before executing workflows that use that WASM module.

## Error Messages

### Non-Whitelisted Owner with WASM Steps

```
Owner 0x9999... is NOT whitelisted - WASM steps will be skipped
Skipping 2 WASM step(s) - owner not whitelisted or WASM client/database not available
```

### Contract Step References WASM (Owner Not Whitelisted)

```
Error: Contract step references WASM result but owner is not whitelisted for WASM execution. 
WASM steps were skipped. Please whitelist the workflow owner or remove WASM references from contract steps.
```

## Best Practices

1. **Start with Whitelist Disabled**: During development, keep `WASM_WHITELIST_ENABLED=false` to allow all owners.

2. **Use Database for Production**: Store whitelist in MongoDB for easier management without redeploying.

3. **Monitor Logs**: Watch for whitelist warnings to identify workflows that need whitelisting.

4. **Gradual Rollout**: Add owners to whitelist gradually as you verify their WASM modules.

5. **Document Owners**: Use the `notes` field in the database to document why an owner is whitelisted.

## Troubleshooting

### Workflow Fails with "owner not whitelisted"

**Solution**: Add the workflow owner to the whitelist:
```bash
# Option 1: Add to environment variable
WASM_WHITELIST_ADDRESSES=0xOwnerAddress,...

# Option 2: Add to MongoDB
db.wasm_whitelist.insertOne({
  owner: "0xowneraddress", // lowercase
  enabled: true
});
```

### Contract Steps Fail with WASM Reference Error

**Solution**: Either:
1. Whitelist the owner (recommended if WASM is needed)
2. Remove WASM references from contract steps (if WASM is optional)

### Whitelist Not Working

**Check**:
1. `WASM_WHITELIST_ENABLED=true` is set
2. Owner address matches exactly (case-insensitive, but stored lowercase)
3. Database connection is working (if using database whitelist)
4. Restart the simulator after changing environment variables

## Security Considerations

- **Whitelist is Case-Insensitive**: Addresses are normalized to lowercase before comparison
- **Database Override**: Database whitelist takes precedence over environment variable
- **Fail-Safe**: If whitelist is enabled but check fails, WASM steps are skipped (not executed)
- **Clear Errors**: Non-whitelisted owners get clear error messages, not silent failures
