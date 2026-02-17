#!/usr/bin/env python3
"""
Fetch blob list from Azure Blob Storage container.

Usage:
    fetch_blobs.py --base-url URL --output FILE [--download-base URL]

Environment variables (alternative to arguments):
    BASE_URL        - Azure Blob Storage container URL
    DOWNLOAD_BASE   - Base URL for download links (defaults to BASE_URL)
"""

import argparse
import gzip
import json
import os
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime


def log(msg: str) -> None:
    """Print a timestamped log message."""
    print(f"[{datetime.now().isoformat()}] {msg}", flush=True)


def fetch_page(base_url: str, download_base: str, marker: str | None = None) -> tuple[list[dict], str | None]:
    """
    Fetch a single page of blobs from Azure Blob Storage.
    
    Args:
        base_url: Azure Blob Storage container URL
        download_base: Base URL for download links
        marker: Continuation marker from previous page (None for first page)
    
    Returns:
        Tuple of (list of blob dicts, next marker or None)
    """
    # Azure Blob Storage max page size is 5000
    max_results = 5000
    
    url = f"{base_url}?restype=container&comp=list&maxresults={max_results}"
    if marker:
        url += f"&marker={urllib.parse.quote(marker)}"
    
    req = urllib.request.Request(url)
    req.add_header('Accept-Encoding', 'gzip')
    
    with urllib.request.urlopen(req, timeout=120) as response:
        # Handle gzip-compressed responses
        if response.info().get('Content-Encoding') == 'gzip':
            xml_data = gzip.decompress(response.read()).decode('utf-8')
        else:
            xml_data = response.read().decode('utf-8')
    
    # Parse XML response
    root = ET.fromstring(xml_data)
    
    page_blobs = []
    for blob in root.findall('.//Blob'):
        name = blob.findtext('Name', '')
        props = blob.find('Properties')
        
        if name:
            encoded_name = urllib.parse.quote(name, safe='/')
            blob_data = {
                "Name": name,
                "Url": f"{download_base}/{encoded_name}",
                "Length": int(props.findtext('Content-Length', '0')) if props is not None else 0,
                "LastModified": props.findtext('Last-Modified', '') if props is not None else '',
                "ContentType": props.findtext('Content-Type', '') if props is not None else ''
            }
            page_blobs.append(blob_data)
    
    next_marker = root.findtext('NextMarker') or None
    return page_blobs, next_marker


def fetch_all_blobs(base_url: str, download_base: str) -> list[dict]:
    """
    Fetch all blobs from an Azure Blob Storage container.
    
    Args:
        base_url: Azure Blob Storage container URL
        download_base: Base URL for download links
    
    Returns:
        List of blob dictionaries
    """
    blobs = []
    marker = None
    page_num = 0
    
    while True:
        page_num += 1
        log(f"Fetching blob list (page {page_num}, total so far: {len(blobs)})...")
        
        page_blobs, marker = fetch_page(base_url, download_base, marker)
        blobs.extend(page_blobs)
        log(f"Page {page_num}: {len(page_blobs)} blobs")
        
        if not marker:
            break
    
    return blobs


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Fetch blob list from Azure Blob Storage container'
    )
    parser.add_argument(
        '--base-url',
        default=os.environ.get('BASE_URL', ''),
        help='Azure Blob Storage container URL (or set BASE_URL env var)'
    )
    parser.add_argument(
        '--download-base',
        default=os.environ.get('DOWNLOAD_BASE', ''),
        help='Base URL for download links (defaults to base-url)'
    )
    parser.add_argument(
        '--output', '-o',
        required=True,
        help='Output JSON file path'
    )
    
    args = parser.parse_args()
    
    # Validate arguments
    if not args.base_url:
        log("ERROR: --base-url or BASE_URL environment variable is required")
        return 1
    
    # Default download base to base URL if not specified
    download_base = args.download_base or args.base_url
    
    try:
        log(f"Starting blob list fetch from {args.base_url}")
        blobs = fetch_all_blobs(args.base_url, download_base)
        log(f"Fetched {len(blobs)} blobs total")
        
        # Write JSON output
        with open(args.output, 'w') as f:
            json.dump(blobs, f, indent=2)
        
        log(f"JSON file written to {args.output}")
        return 0
        
    except urllib.error.URLError as e:
        log(f"ERROR: Network error - {e}")
        return 1
    except ET.ParseError as e:
        log(f"ERROR: Failed to parse XML response - {e}")
        return 1
    except Exception as e:
        log(f"ERROR: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())
