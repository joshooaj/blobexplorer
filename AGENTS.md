# Repository Guidelines

## Project overview

Blob Explorer is a self-hosted web UI for browsing and downloading files from any public Azure Blob Storage container. It ships as one Docker image: nginx serves a static vanilla-JS site and proxies Azure requests, while a background updater writes the container listing to JSON files. There is no framework, build step, or third-party runtime dependency.

## Architecture and data flow

1. `scripts/entrypoint.sh` validates `BASE_URL`, writes a default `/config/config.json` when missing, runs `scripts/generate-config.sh`, replaces the `__DNS_RESOLVER__` placeholder in nginx.conf with nameservers from `/etc/resolv.conf`, restores `/cache` data when it matches `BASE_URL`, starts a background update loop on `UPDATE_INTERVAL`, then execs nginx on port 8080.
2. `scripts/generate-config.sh` merges `/config/config.json` with environment variables (env wins) and writes `/usr/share/nginx/html/config.js`, which defines `window.APP_CONFIG`. It also rewrites `<title>`, the meta description, and an injected analytics script in the deployed copy of `index.html`. Repo `index.html` always keeps the default values; never hardcode a deployment title there.
3. `scripts/update-downloads.sh` calls `scripts/fetch_blobs.py` (Azure list API, marker paging at 5000 blobs per page) to produce `data/downloads.json` plus `data/metadata.json`, pre-compresses with gzip for nginx `gzip_static`, and copies results to the `/cache` volume for fast restarts.
4. The browser fetches `data/downloads.json`, builds an in-memory folder tree, and caches the listing in IndexedDB (`BlobExplorerDB`). The custom-container feature fetches through the nginx location `/api/blob-proxy/{account}.blob.core.windows.net/{container}`, which is the only thing supplying CORS headers.

## Key directories

- `site/` everything delivered to the browser: `index.html` (all markup, dialogs, help tables), `app.js` (the entire UI), `styles.css`, `assets/`.
- `scripts/` container runtime scripts: POSIX sh plus one python3 CLI.
- `config/` `config.schema.json`, `config.default.json`, and a gitignored local `config.json`.
- `tests/` dev-only checks: `app.test.mjs` (node:test) and `test_fetch_blobs.py` (unittest).
- `.github/workflows/` `publish.yaml` (multi-arch image build and push) and `test.yaml` (lint, JS, Python, shellcheck).

## Development commands

No build step; `site/` files ship as-is. `package.json` holds dev-only tooling (ESLint, node:test) and never enters the image, which copies only `site/`, `config/`, `scripts/`, and `nginx.conf`.

```bash
cp docker-compose.override.example.yaml docker-compose.override.yaml  # set BASE_URL, uncomment ports
docker compose up -d --build    # then browse http://localhost:8080
```

Serving `site/` with a static file server cannot run the app: the page needs the startup-generated `config.js` and the nginx blob proxy. Test changes only inside the container.

Releasing: push a `v*` tag; the workflow publishes semver tags to Docker Hub and GHCR. Pushes to `main` publish `edge`.

## Code conventions and common patterns

- `site/app.js` is one plain script: no modules, no classes, no imports. Flat top-level functions grouped under banner comments. Naming: `initializeX` wires DOM once, `renderX` writes DOM, `updateX` refreshes existing DOM, `loadData` fetches. Shared mutable state lives in module-level variables (`allDownloads`, `filteredDownloads`).
- Interpolate strings into HTML only through `esc()`.
- Per-visitor state uses `localStorage` keys `explorerSort`, `explorerTreeExpanded`, `userFavorites`, `customStorageUrl`; the blob listing uses IndexedDB.
- User-facing actions fire `blob-explorer:*` DOM events through `BlobExplorerAnalytics` so admin-supplied analytics scripts can listen. A new action of the same class as an existing table row in the README analytics section should fire a matching event.
- Features carry accessibility: keyboard handling in `initializeKeyboardShortcuts`, aria labels, modal focus traps (`setupFocusTrap`). Touch-specific behavior branches on `IS_TOUCH`.
- Keyboard shortcuts exist in three synced places: `initializeKeyboardShortcuts` in `app.js`, the help dialog markup in `index.html`, and the README keyboard table. Update all three together.
- Shell scripts use `#!/bin/sh` and `set -e`, and parse JSON with `python3`; the image has no `jq`.
- Git: Conventional Commits (`fix:`, `feat:`, `refactor:`, `docs:`), branches like `fix/short-topic`, work merged to `main` by PR.

## Important files

- `site/app.js` all UI logic; the startup sequence is the `DOMContentLoaded` block at the end.
- `site/index.html` single page with every dialog and table.
- `nginx.conf` blob proxy, cache policies, `__DNS_RESOLVER__` placeholder. Static assets carry no content hashes, so their `Cache-Control` is `no-cache`; `immutable` would pin stale code across rebuilds.
- A config option is defined in four places: `config/config.schema.json`, `config/config.default.json`, the `read_config` heredoc in `scripts/generate-config.sh`, and the Dockerfile `ENV` line when it has an env-var form. Adding one means updating all four.
- `docker-compose.override.example.yaml` the user-facing template; `docker-compose.override.yaml` and `config/config.json` are gitignored working files.

## Runtime and tooling preferences

The runtime needs only Docker or podman. Dev tooling: Node (`node:test`, ESLint; CI pins Node 22), host `python3` for unittest, and podman or docker for the shellcheck container. The site itself stays dependency-free: no CDNs, webfonts, or third-party JS. The image is multi-arch (amd64, arm64) and rootless-friendly, so keep runtime-writable paths (`/config`, `/cache`, nginx dirs) chmod-writable for any UID in the Dockerfile.

## Testing and QA

Run all checks with: `npm run lint`, `npm test` (node:test), `npm run test:python`, `npm run test:shell` (shellcheck in a podman container). CI (`test.yaml`) runs the same set.

- `tests/app.test.mjs` imports `site/app.js` through the CommonJS test-seam guard at the bottom of that file, which exports pure helpers (`esc`, `getFileExtension`, `formatFileSize`, `wildcardToRegex`, `fuzzyScore`, `makeSearchMatcher`). Add helpers to that export list when they are pure and worth covering.
- `tests/test_fetch_blobs.py` drives `scripts/fetch_blobs.py` against a local stdlib HTTP server replaying Azure `comp=list` XML (paging, gzip, field mapping); no network or Azure account is needed.
- For UI changes, also smoke the real container: `podman build -t be . && podman run -e BASE_URL=https://cascadiatechstore.blob.core.windows.net/blobexplorer -p 8080:8080 be`, then browse `http://localhost:8080`. The entrypoint exits when the first blob fetch fails; that is deliberate validation of `BASE_URL`.
- README tables for env vars, features, shortcuts, and analytics events are the behavioral contract; keep them in sync with code changes.
