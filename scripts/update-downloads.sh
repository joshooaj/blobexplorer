#!/bin/sh
set -e

# Data is served from DATA_DIR, but also saved to CACHE_DIR for persistence
DATA_DIR="/usr/share/nginx/html/data"
CACHE_DIR="/cache"
JSON_FILE="$DATA_DIR/downloads.json"
TEMP_FILE="$DATA_DIR/downloads.json.tmp"

log() {
    echo "[$(date -Iseconds)] $*"
}

fetch_downloads() {
    log "Starting download list update from $BASE_URL..."
    
    # Fetch blobs using Python script
    if ! python3 /scripts/fetch_blobs.py \
        --base-url "$BASE_URL" \
        --download-base "${DOWNLOAD_BASE:-$BASE_URL}" \
        --output "$TEMP_FILE"; then
        log "Fetch script failed!"
        rm -f "$TEMP_FILE"
        return 1
    fi
    
    # Validate JSON
    if ! python3 -c "import json; json.load(open('$TEMP_FILE'))" 2>/dev/null; then
        log "ERROR: Generated JSON is invalid!"
        rm -f "$TEMP_FILE"
        return 1
    fi
    
    # Move temp file to final location
    mv "$TEMP_FILE" "$JSON_FILE"
    log "Saved to $JSON_FILE"
    
    # Write metadata file with update timestamp and source URL
    METADATA_FILE="$DATA_DIR/metadata.json"
    BLOB_COUNT=$(python3 -c "import json; print(len(json.load(open('$JSON_FILE'))))")
    echo "{\"lastUpdated\": \"$(date -Iseconds)\", \"blobCount\": $BLOB_COUNT, \"baseUrl\": \"$BASE_URL\"}" > "$METADATA_FILE"
    log "Wrote metadata to $METADATA_FILE"
    
    # Pre-compress with gzip
    log "Compressing with gzip..."
    gzip -9 -k -f "$JSON_FILE"
    log "Compressed to ${JSON_FILE}.gz"
    
    # Copy to cache directory for persistence across container restarts
    if [ -d "$CACHE_DIR" ]; then
        log "Saving to cache directory..."
        cp "$JSON_FILE" "$CACHE_DIR/downloads.json"
        cp "${JSON_FILE}.gz" "$CACHE_DIR/downloads.json.gz"
        cp "$METADATA_FILE" "$CACHE_DIR/metadata.json"
        log "Cache updated"
    fi
    
    # Show file sizes
    JSON_SIZE=$(du -h "$JSON_FILE" | cut -f1)
    GZ_SIZE=$(du -h "${JSON_FILE}.gz" | cut -f1)
    log "File sizes: JSON=$JSON_SIZE, Gzipped=$GZ_SIZE"
    
    log "Update complete!"
}

# Run the fetch
fetch_downloads
