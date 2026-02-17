#!/bin/sh
set -e

CONFIG_DIR="/config"
CONFIG_FILE="$CONFIG_DIR/config.json"
DEFAULT_CONFIG="/config-defaults/config.default.json"
CACHE_DIR="/cache"
DATA_DIR="/usr/share/nginx/html/data"
CACHE_JSON="$CACHE_DIR/downloads.json"
CACHE_METADATA="$CACHE_DIR/metadata.json"

log() {
    echo "[$(date -Iseconds)] $*"
}

# Check if cached data is for a different BASE_URL
is_cache_url_mismatch() {
    if [ ! -f "$CACHE_METADATA" ]; then
        return 1  # No metadata = no mismatch (just missing)
    fi
    
    CACHED_URL=$(python3 -c "
import json
try:
    with open('$CACHE_METADATA') as f:
        meta = json.load(f)
    print(meta.get('baseUrl', ''))
except:
    print('')
" 2>/dev/null)
    
    if [ -n "$CACHED_URL" ] && [ "$CACHED_URL" != "$BASE_URL" ]; then
        log "Cache URL mismatch: cached='$CACHED_URL', current='$BASE_URL'"
        return 0  # Mismatch
    fi
    return 1  # No mismatch
}

# Check if cached data is stale (older than UPDATE_INTERVAL)
is_cache_stale() {
    if [ ! -f "$CACHE_METADATA" ]; then
        return 0  # No metadata = stale
    fi
    
    # Get last updated timestamp from metadata
    LAST_UPDATED=$(python3 -c "
import json
import sys
from datetime import datetime, timezone

try:
    with open('$CACHE_METADATA') as f:
        meta = json.load(f)
    last_updated = meta.get('lastUpdated', '')
    if not last_updated:
        sys.exit(0)  # No timestamp = stale
    
    # Parse ISO timestamp
    dt = datetime.fromisoformat(last_updated.replace('Z', '+00:00'))
    now = datetime.now(timezone.utc)
    age_seconds = (now - dt).total_seconds()
    
    update_interval = int('${UPDATE_INTERVAL:-86400}')
    if age_seconds > update_interval:
        print(f'Cache is {int(age_seconds)}s old (threshold: {update_interval}s)')
        sys.exit(0)  # Stale
    else:
        print(f'Cache is {int(age_seconds)}s old (threshold: {update_interval}s)')
        sys.exit(1)  # Fresh
except Exception as e:
    print(f'Error checking cache age: {e}')
    sys.exit(0)  # Error = treat as stale
" 2>&1)
    
    RESULT=$?
    log "$LAST_UPDATED"
    return $RESULT
}

# Validate required environment variables
if [ -z "$BASE_URL" ]; then
    echo "ERROR: BASE_URL environment variable is required."
    echo "Example: BASE_URL=https://myaccount.blob.core.windows.net/mycontainer"
    exit 1
fi

# Set DOWNLOAD_BASE to BASE_URL if not specified
DOWNLOAD_BASE="${DOWNLOAD_BASE:-$BASE_URL}"
export DOWNLOAD_BASE

log "Starting Blob Explorer"
log "BASE_URL: $BASE_URL"
log "DOWNLOAD_BASE: $DOWNLOAD_BASE"
log "UPDATE_INTERVAL: ${UPDATE_INTERVAL}s"

# Ensure directories exist
mkdir -p "$CONFIG_DIR" "$CACHE_DIR" "$DATA_DIR"

# Create default config file if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    log "No config file found at $CONFIG_FILE, creating default..."
    cp "$DEFAULT_CONFIG" "$CONFIG_FILE"
    # Also copy the schema for editor support
    if [ -f "/config-defaults/config.schema.json" ]; then
        cp "/config-defaults/config.schema.json" "$CONFIG_DIR/config.schema.json"
    fi
    log "Default config created. Edit $CONFIG_FILE to customize favorites and other settings."
else
    log "Using existing config file: $CONFIG_FILE"
fi

# Generate runtime configuration (reads from config file + env vars)
log "Generating runtime configuration..."
/scripts/generate-config.sh

# Configure nginx DNS resolver from system resolv.conf
DNS_SERVERS=$(grep -E '^nameserver' /etc/resolv.conf | awk '{print $2}' | tr '\n' ' ')
if [ -n "$DNS_SERVERS" ]; then
    log "Configuring nginx DNS resolver: $DNS_SERVERS"
    sed -i "s/__DNS_RESOLVER__/$DNS_SERVERS/" /etc/nginx/conf.d/default.conf
else
    log "Warning: No DNS servers found, using 127.0.0.11"
    sed -i "s/__DNS_RESOLVER__/127.0.0.11/" /etc/nginx/conf.d/default.conf
fi

# Check for cached data and copy to data directory if available
NEEDS_UPDATE=false
if [ -f "$CACHE_JSON" ]; then
    # Check if cache is for a different BASE_URL
    if is_cache_url_mismatch; then
        log "BASE_URL has changed, invalidating cache and fetching fresh data..."
        rm -f "$CACHE_JSON" "${CACHE_JSON}.gz" "$CACHE_METADATA"
        /scripts/update-downloads.sh
    else
        log "Found cached data, copying to data directory..."
        cp "$CACHE_JSON" "$DATA_DIR/downloads.json"
        [ -f "${CACHE_JSON}.gz" ] && cp "${CACHE_JSON}.gz" "$DATA_DIR/downloads.json.gz"
        [ -f "$CACHE_METADATA" ] && cp "$CACHE_METADATA" "$DATA_DIR/metadata.json"
        
        # Check if cache is stale
        if is_cache_stale; then
            log "Cached data is stale, will update in background..."
            NEEDS_UPDATE=true
        else
            log "Cached data is fresh, no immediate update needed"
        fi
    fi
else
    log "No cached data found, performing initial fetch..."
    /scripts/update-downloads.sh
fi

# Start background update process
log "Starting background updater (interval: ${UPDATE_INTERVAL}s)..."
(
    # If cache was stale, update immediately (but don't block startup)
    if [ "$NEEDS_UPDATE" = "true" ]; then
        log "Running immediate background update for stale cache..."
        /scripts/update-downloads.sh || log "Background update failed, will retry next interval"
    fi
    
    # Regular update loop
    while true; do
        sleep "$UPDATE_INTERVAL"
        log "Running scheduled update..."
        /scripts/update-downloads.sh || log "Update failed, will retry next interval"
    done
) &

# Start nginx in foreground
log "Starting nginx..."
exec nginx -g "daemon off;"
