// App State
let allDownloads = [];
let filteredDownloads = [];
let currentPath = [];
let activeFileTypes = new Set();
let allFileTypesSelected = true; // true = show all types, false = use activeFileTypes set
// name/type/date/size, each -asc or -desc. A first-time visitor starts
// alphabetical (name-asc); applySort persists the visitor's choice.
const SORT_OPTIONS = ['name-asc', 'name-desc', 'type-asc', 'type-desc',
    'date-asc', 'date-desc', 'size-asc', 'size-desc'];
const storedSort = localStorage.getItem('explorerSort');
let sortBy = SORT_OPTIONS.includes(storedSort) ? storedSort : 'name-asc';

// Performance optimizations
let folderTree = new Map(); // Hierarchical folder structure for O(1) navigation
let fileTypeCache = new Map(); // Cache file type info to avoid repeated calculations
let folderSizes = new Map(); // path -> recursive total bytes of all blobs under that prefix
let folderDates = new Map(); // path -> newest LastModified (ms) among all blobs under that prefix (recursive)

// Escape text interpolated into innerHTML. Container names (folders, file
// names, URLs) are untrusted input: the product deliberately browses public
// containers its operators have never seen, so every blob-derived string
// rendered via a template must pass through esc() first.
function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// The typed query as entered (the lowercase searchTerm drives matching;
// messages echo what the visitor actually wrote).
function searchInputRaw() {
    return document.getElementById('searchInput').value.trim();
}

// Analytics Events API
// ============================================================================
// Dispatches custom events that external analytics scripts can listen to.
// All events are dispatched on `document` with the prefix 'blob-explorer:'.
//
// Available events:
//   blob-explorer:page-view      - Page loaded or navigated
//   blob-explorer:search         - User performed a search
//   blob-explorer:download       - User clicked download button
//   blob-explorer:copy-link      - User copied a download link
//   blob-explorer:folder-navigate - User navigated to a folder
//   blob-explorer:filter-change  - User changed file type filters
//   blob-explorer:theme-change   - User toggled theme
//   blob-explorer:favorite-add   - User added a favorite
//   blob-explorer:favorite-remove - User removed a favorite
//   blob-explorer:custom-url-load - User loaded a custom storage URL
//
// Example usage with Google Analytics:
//   document.addEventListener('blob-explorer:download', (e) => {
//     gtag('event', 'download', {
//       file_name: e.detail.fileName,
//       file_path: e.detail.filePath,
//       file_size: e.detail.fileSize
//     });
//   });
//
// Example usage with Plausible:
//   document.addEventListener('blob-explorer:download', (e) => {
//     plausible('Download', { props: { file: e.detail.fileName } });
//   });

const BlobExplorerAnalytics = {
    /**
     * Dispatch a custom analytics event
     * @param {string} eventName - Event name (without prefix)
     * @param {object} detail - Event data
     */
    dispatch(eventName, detail = {}) {
        const event = new CustomEvent(`blob-explorer:${eventName}`, {
            detail: {
                ...detail,
                timestamp: new Date().toISOString()
            },
            bubbles: true,
            cancelable: false
        });
        document.dispatchEvent(event);
    },

    /** Track page view or navigation */
    pageView(path = window.location.pathname) {
        this.dispatch('page-view', { path, url: window.location.href });
    },

    /** Track search query */
    search(query, resultCount) {
        this.dispatch('search', { query, resultCount });
    },

    /** Track file download */
    download(fileName, filePath, fileSize, fileType) {
        this.dispatch('download', { fileName, filePath, fileSize, fileType });
    },

    /** Track copy link action */
    copyLink(fileName, filePath) {
        this.dispatch('copy-link', { fileName, filePath });
    },

    /** Track folder navigation */
    folderNavigate(folderPath, folderName) {
        this.dispatch('folder-navigate', { folderPath, folderName });
    },

    /** Track filter changes */
    filterChange(activeFilters, totalFilters) {
        this.dispatch('filter-change', { activeFilters, totalFilters });
    },

    /** Track theme toggle */
    themeChange(theme) {
        this.dispatch('theme-change', { theme });
    },

    /** Track favorite added */
    favoriteAdd(label, type, path) {
        this.dispatch('favorite-add', { label, type, path });
    },

    /** Track favorite removed */
    favoriteRemove(label, type, path) {
        this.dispatch('favorite-remove', { label, type, path });
    },

    /** Track custom storage URL loaded */
    customUrlLoad(url, blobCount) {
        // Extract host + container path without exposing query params (e.g. SAS tokens)
        let host = '';
        let container = '';
        try {
            const parsed = new URL(url);
            host = parsed.hostname;
            container = parsed.pathname.replace(/^\//, '');
        } catch { /* ignore */ }
        this.dispatch('custom-url-load', { host, container, blobCount });
    }
};

// Expose analytics API globally for external scripts
window.BlobExplorerAnalytics = BlobExplorerAnalytics;

// Get favorites configuration from runtime config (loaded from config.js)
// Supports three types:
// - folder: Navigate to a specific folder path
// - search: Run a search query  
// - pattern: Auto-match folders using regex pattern
function getFavoritesConfig() {
    if (typeof window.APP_CONFIG !== 'undefined' && Array.isArray(window.APP_CONFIG.favorites)) {
        return window.APP_CONFIG.favorites;
    }
    return [];
}

// Accessibility helper - make element keyboard accessible
function makeKeyboardAccessible(element, clickHandler) {
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            clickHandler(e);
        }
    });
    element.addEventListener('click', clickHandler);
}

// ---------------------------------------------------------------------------
// Fluent glyphs and explorer state (selection, nav tree, view modes)
// ---------------------------------------------------------------------------
const FL = {
    folder: '<svg viewBox="0 0 24 24" class="ico-folder" aria-hidden="true"><path d="M2.5 6.1c0-.9.75-1.6 1.65-1.6h5.05c.5 0 .98.22 1.3.61l.98 1.19h8.37c.9 0 1.65.7 1.65 1.6v.85H2.5V6.1z" fill="var(--folder-back)"/><path d="M2.5 8.6h19v9.3c0 .95-.75 1.6-1.65 1.6H4.15c-.9 0-1.65-.65-1.65-1.6V8.6z" fill="var(--folder-front)"/></svg>',
    copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.2" y="3.7" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M12.3 15.8v.5a1.5 1.5 0 0 1-1.5 1.5H4.8a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5h.5" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
    download: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v9M5.8 8.5 10 12.7l4.2-4.2M4 16.3h12" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.8 10.5 3.4 3.4 7-7.4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    open: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 6.1c0-.9.75-1.6 1.65-1.6h5.05c.5 0 .98.22 1.3.61l.98 1.19h8.37c.9 0 1.65.7 1.65 1.6v.85H2.5V6.1z" fill="currentColor" opacity="0.85"/><path d="M2.5 8.6h19v9.3c0 .95-.75 1.6-1.65 1.6H4.15c-.9 0-1.65-.65-1.65-1.6V8.6z" fill="currentColor" opacity="0.5"/></svg>',
    empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 6.1c0-.9.75-1.6 1.65-1.6h5.05c.5 0 .98.22 1.3.61l.98 1.19h8.37c.9 0 1.65.7 1.65 1.6v.85H2.5V6.1z" fill="currentColor"/><path d="M2.5 8.6h19v9.3c0 .95-.75 1.6-1.65 1.6H4.15c-.9 0-1.65-.65-1.65-1.6V8.6z" fill="currentColor" opacity="0.55"/></svg>',
    home: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 9.3 10 3.6l6.5 5.7M5.2 8v7.4c0 .4.3.6.6.6h3.1v-3.6c0-.4.2-.6.6-.6h1c.4 0 .6.2.6.6v3.6h3.1c.3 0 .6-.2.6-.6V8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const IS_TOUCH = window.matchMedia('(hover: none)').matches;
let selectedRow = null;
let selectedKey = null;
let viewItems = []; // flat list backing the windowed render: {type:'folder',name,path} | {type:'file',data}
let viewFromSearch = false;
let emptyMessage = '';
let winStart = -1;
let winEnd = -1;
let navDepth = 0;
let viewMode = localStorage.getItem('explorerView') || 'list';
let detailsOpen = localStorage.getItem('explorerDetails') === 'on';
let navOpen = localStorage.getItem('explorerNav') !== 'off';

const treeExpanded = new Set(JSON.parse(localStorage.getItem('explorerTreeExpanded') || '[]'));
function saveTreeExpanded() { localStorage.setItem('explorerTreeExpanded', JSON.stringify([...treeExpanded])); }


// User Favorites (stored in localStorage)
const USER_FAVORITES_KEY = 'userFavorites';

function getUserFavorites() {
    try {
        const stored = localStorage.getItem(USER_FAVORITES_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to load user favorites:', e);
        return [];
    }
}

function saveUserFavorites(favorites) {
    try {
        localStorage.setItem(USER_FAVORITES_KEY, JSON.stringify(favorites));
    } catch (e) {
        console.error('Failed to save user favorites:', e);
    }
}

function addUserFavorite(favorite) {
    const favorites = getUserFavorites();
    favorite.id = Date.now(); // Unique ID
    favorites.push(favorite);
    saveUserFavorites(favorites);
    BlobExplorerAnalytics.favoriteAdd(favorite.label, favorite.type, favorite.path || favorite.query || '');
    return favorite;
}

function updateUserFavorite(id, updates) {
    const favorites = getUserFavorites();
    const index = favorites.findIndex(f => f.id === id);
    if (index !== -1) {
        favorites[index] = { ...favorites[index], ...updates };
        saveUserFavorites(favorites);
    }
}

function deleteUserFavorite(id) {
    const favorites = getUserFavorites();
    const favorite = favorites.find(f => f.id === id);
    if (favorite) {
        BlobExplorerAnalytics.favoriteRemove(favorite.label, favorite.type, favorite.path || favorite.query || '');
    }
    saveUserFavorites(favorites.filter(f => f.id !== id));
}

// IndexedDB for caching
const DB_NAME = 'BlobExplorerDB';
const DB_VERSION = 1;
const STORE_NAME = 'downloads';

// Initialize IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

// Format relative time (e.g., "2 hours ago")
function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    
    return date.toLocaleDateString();
}

// Fetch metadata and optionally display last updated timestamp
async function fetchMetadata(updateUI = true) {
    try {
        const response = await fetch('data/metadata.json', { cache: 'no-cache' });
        if (response.ok) {
            const metadata = await response.json();
            if (updateUI) {
                const lastUpdatedEl = document.getElementById('lastUpdated');
                if (lastUpdatedEl && metadata.lastUpdated) {
                    const relativeTime = formatRelativeTime(metadata.lastUpdated);
                    lastUpdatedEl.textContent = relativeTime;
                    lastUpdatedEl.title = 'Last updated ' + new Date(metadata.lastUpdated).toLocaleString();
                }
            }
            return metadata;
        }
    } catch {
        // metadata.json is optional; missing metadata just skips the UI update.
    }
    return null;
}

// Get cached data
async function getCachedData() {
    try {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get('allDownloads');
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('IndexedDB error:', error);
        return null;
    }
}

// Cache data
async function cacheData(data) {
    try {
        const db = await initDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data, 'allDownloads');
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Failed to cache data:', error);
    }
}

// Load data directly (without Web Worker for reliability)
async function loadData() {
    const loadingEl = document.getElementById('tableRows');
    
    try {
        // Fetch metadata first to check if server data is newer than cache
        loadingEl.innerHTML = '<div class="loading">Checking for updates...</div>';
        const metadata = await fetchMetadata(true);
        const serverLastUpdated = metadata && metadata.lastUpdated ? new Date(metadata.lastUpdated).getTime() : null;
        
        // Try to load from cache, but only if it matches the server's last update
        const cached = await getCachedData();
        if (cached && cached.downloads && cached.downloads.length > 0) {
            const cacheIsStale = serverLastUpdated && (!cached.serverLastUpdated || cached.serverLastUpdated < serverLastUpdated);
            
            if (!cacheIsStale) {
                loadingEl.innerHTML = '<div class="loading">Loading from cache...</div>';
                allDownloads = prepareDownloads(cached.downloads);
                filteredDownloads = [...allDownloads];
                
                // Build optimized data structures
                buildFolderTree();
                renderFolderNav();
                if (cached.timestamp) {
                    const lu = document.getElementById('lastUpdated');
                    if (lu) {
                        lu.textContent = formatRelativeTime(new Date(cached.timestamp).toISOString());
                        lu.title = 'Last updated ' + new Date(cached.timestamp).toLocaleString();
                    }
                }
                
                initializeFilters();
                renderFavorites();
                displayDownloads();
                return;
            }
        }
        loadingEl.innerHTML = '<div class="loading">Downloading the container listing…</div>';
        
        // Load directly - more reliable than Web Worker
        const response = await fetch('data/downloads.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        loadingEl.innerHTML = '<div class="loading">Processing data... Please wait.</div>';
        
        const text = await response.text();
        
        loadingEl.innerHTML = '<div class="loading">Parsing JSON... Almost done.</div>';
        
        const downloads = JSON.parse(text);
        
        allDownloads = prepareDownloads(downloads);
        filteredDownloads = [...allDownloads];
        
        // Build optimized data structures
        buildFolderTree();
        renderFolderNav();
        
        // Cache the data with the server's lastUpdated timestamp for future freshness checks
        await cacheData({ downloads, timestamp: Date.now(), serverLastUpdated: serverLastUpdated || Date.now() });
        
        initializeFilters();
        renderFavorites();
        displayDownloads();
        
    } catch (error) {
        console.error('Error loading downloads:', error);
        loadingEl.innerHTML = `<div class="no-results">Error loading downloads: ${error.message}<br>Please check the console for details.</div>`;
    }
}

// Build hierarchical folder tree for O(1) navigation
function buildFolderTree() {
    folderTree.clear();
    fileTypeCache.clear();
    folderSizes.clear();
    folderDates.clear();
    
    // Initialize root
    folderTree.set('', { folders: new Set(), files: [] });
    
    allDownloads.forEach(download => {
        const parts = download.Name.split('/');
        
        // Pre-cache file type info
        getFileTypeInfo(download);
        
        // Add file to its parent folder
        const parentPath = parts.slice(0, -1).join('/');
        if (!folderTree.has(parentPath)) {
            folderTree.set(parentPath, { folders: new Set(), files: [] });
        }
        folderTree.get(parentPath).files.push(download);
        // Recursive size rollup: add this blob's bytes to every ancestor prefix
        const bytes = Number(download.Length) || 0;
        if (bytes) {
            for (let i = 0; i <= parts.length - 1; i++) {
                const ancestor = parts.slice(0, i).join('/');
                folderSizes.set(ancestor, (folderSizes.get(ancestor) || 0) + bytes);
            }
        }
        // Recursive date rollup: newest LastModified among descendants
        const ts = new Date(download.LastModified).getTime();
        if (Number.isFinite(ts)) {
            for (let i = 0; i <= parts.length - 1; i++) {
                const ancestor = parts.slice(0, i).join('/');
                if ((folderDates.get(ancestor) || 0) < ts) folderDates.set(ancestor, ts);
            }
        }
        
        // Build folder hierarchy
        for (let i = 0; i < parts.length - 1; i++) {
            const currentPath = parts.slice(0, i).join('/');
            const childFolder = parts[i];
            const childPath = parts.slice(0, i + 1).join('/');
            
            if (!folderTree.has(currentPath)) {
                folderTree.set(currentPath, { folders: new Set(), files: [] });
            }
            folderTree.get(currentPath).folders.add(childFolder);
            
            if (!folderTree.has(childPath)) {
                folderTree.set(childPath, { folders: new Set(), files: [] });
            }
        }
    });
}

// Get file extension from URL
function getFileExtension(url) {
    const match = url.match(/\.([^./?#]+)(?:[?#]|$)/);
    return match ? match[1].toLowerCase() : 'unknown';
}

// Get file type display name and icon
function getFileTypeInfo(download) {
    // Check cache first
    if (fileTypeCache.has(download.Url)) {
        return fileTypeCache.get(download.Url);
    }
    
    const ext = getFileExtension(download.Url);
    
    // Material Design style SVG icons
    const icons = {
        pdf: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-2.5 5.5c0 .83-.67 1.5-1.5 1.5h-1v2H7v-6h2.5c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5v-6H15c.83 0 1.5.67 1.5 1.5v3zm4-3h-1.5v1h1.5v1h-1.5v2H18v-6h2.5v1.5z"/></svg>',
        zip: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10h-2v2h-2v-2H8v-2h2v-2h2v2h2v2zm0-6h-2V8h-2v2H8V8h2V6h2v2h2v2z"/></svg>',
        web: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
        txt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zm-9-4h4v2H9v-2zm0-6h6v2H9V10zm0 3h6v2H9v-2z"/></svg>',
        installer: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4zm0 2h16v2H4V6zm0 4h16v10H4V10z"/><path d="M12 11v5m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
        iso: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-12.5c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zm0 5.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>',
        xml: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h6v6h6v10H6z"/><rect x="5.5" y="12" width="13" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><text x="12" y="16.5" font-size="5" font-family="Arial, sans-serif" font-weight="bold" text-anchor="middle" fill="currentColor">XML</text></svg>',
        json: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/><path d="M9.5 12.5c0-.83-.67-1.5-1.5-1.5v-1c1.38 0 2.5 1.12 2.5 2.5V14h-1v-1.5zm5 0V14h-1v-1.5c0-1.38 1.12-2.5 2.5-2.5v1c-.83 0-1.5.67-1.5 1.5z"/></svg>',
        dll: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/><path d="M9 13h6v2H9z"/></svg>',
        cert: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>',
        image: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
        word: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/><path d="M7 15l1.5-6h1.2l1.3 4 1.3-4h1.2l1.5 6h-1.3l-.9-3.7-1.2 3.7h-1.2l-1.2-3.7-.9 3.7H7z"/></svg>',
        database: '<svg viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5c0 1.66-3.58 3-8 3S4 6.66 4 5z"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6c0 1.66-3.58 3-8 3s-8-1.34-8-3z"/></svg>',
        file: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>'
    };
    
    const typeMap = {
        'pdf': { icon: icons.pdf, name: 'PDF', color: '#d32f2f' },
        'zip': { icon: icons.zip, name: 'ZIP', color: '#ff9800' },
        'htm': { icon: icons.web, name: 'HTML', color: '#1976d2' },
        'html': { icon: icons.web, name: 'HTML', color: '#1976d2' },
        'txt': { icon: icons.txt, name: 'Text', color: '#666' },
        'exe': { icon: icons.installer, name: 'Installer', color: '#00897b' },
        'msi': { icon: icons.installer, name: 'Installer', color: '#00897b' },
        'iso': { icon: icons.iso, name: 'ISO', color: '#5e35b1' },
        'xml': { icon: icons.xml, name: 'XML', color: '#f57c00' },
        'json': { icon: icons.json, name: 'JSON', color: '#388e3c' },
        'dll': { icon: icons.dll, name: 'DLL', color: '#455a64' },
        'cer': { icon: icons.cert, name: 'Certificate', color: '#c62828' },
        'jpg': { icon: icons.image, name: 'Image', color: '#e91e63' },
        'jpeg': { icon: icons.image, name: 'Image', color: '#e91e63' },
        'png': { icon: icons.image, name: 'Image', color: '#e91e63' },
        'gif': { icon: icons.image, name: 'Image', color: '#e91e63' },
        'doc': { icon: icons.word, name: 'Word', color: '#1565c0' },
        'docx': { icon: icons.word, name: 'Word', color: '#1565c0' },
        'db': { icon: icons.database, name: 'Database', color: '#6d4c41' },
    };
    
    const result = typeMap[ext] || { icon: icons.file, name: ext.toUpperCase(), color: '#757575' };
    
    // Cache the result
    fileTypeCache.set(download.Url, result);
    
    return result;
}

// Format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Format date. No locale argument: the browser's locale sets date order,
// month names, and the 12/24-hour clock; the visitor's timezone sets the
// displayed time.
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
        ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Create a manifest row for a file
// @param {Object} download - The download object
// @param {boolean} showPath - Whether to show the folder path (used in search results)
// @returns {HTMLElement} The row element
function createDownloadItemElement(download, showPath = false) {
    const typeInfo = getFileTypeInfo(download);
    const fileName = download.Name.split('/').pop();

    const itemEl = document.createElement('div');
    itemEl.className = 'mrow';
    itemEl.setAttribute('role', 'listitem');
    itemEl.setAttribute('tabindex', '0');
    itemEl.dataset.path = download.Name;
    itemEl.dataset.url = download.Url;
    itemEl.dataset.name = fileName;
    itemEl.dataset.length = download.Length;
    itemEl.dataset.date = download.LastModified;
    itemEl.dataset.type = typeInfo.name;
    itemEl.title = fileName;

    let pathHtml = '';
    let folderPath = '';
    if (showPath) {
        folderPath = download.Name.split('/').slice(0, -1).join('/');
        const folderLabel = folderPath ? folderPath : 'the root folder';
        pathHtml = `<button type="button" class="m-path" title="Open ${esc(folderLabel)}">${folderPath ? esc('/' + folderPath) : '/'}</button>`;
    }

    itemEl.innerHTML = `
        <span class="m-name">
            <span class="m-icon" style="color:${typeInfo.color}">${typeInfo.icon}</span>
            ${pathHtml}<span class="m-name-text">${esc(fileName)}</span>
            <span class="sr-only">${typeInfo.name}, ${formatFileSize(download.Length)}, modified ${formatDate(download.LastModified)}.</span>
        </span>
        <span class="m-date" aria-hidden="true">${formatDate(download.LastModified)}</span>
        <span class="m-type" aria-hidden="true">${esc(typeInfo.name)}</span>
        <span class="m-size">${formatFileSize(download.Length)}</span>
        <span class="m-act">
            <button class="copy-link-button" data-url="${esc(download.Url)}" data-path="${esc(download.Name)}" aria-label="Copy link for ${esc(fileName)}" title="Copy link">${FL.copy}</button>
            <button class="download-button" data-path="${esc(download.Name)}" data-url="${esc(download.Url)}" aria-label="Download ${esc(fileName)}" title="Download">${FL.download}</button>
        </span>
    `;

    if (showPath) {
        itemEl.querySelector('.m-path').addEventListener('click', (e) => {
            e.stopPropagation();
            navigateToPath(folderPath ? folderPath.split('/') : []);
        });
    }

    return itemEl;
}


// Per-query search matchers: one compiled predicate per query instead of a
// fresh RegExp per item. Keyed by the (already lowercased) search term, so
// repeated passes over the same query reuse it.
const searchMatcherCache = new Map();

function makeSearchMatcher(searchTerm) {
    const cached = searchMatcherCache.get(searchTerm);
    if (cached) return cached;

    let matcher;
    if (searchTerm.startsWith('~')) {
        // Fuzzy search: ~ prefix (~~ escapes a literal tilde start)
        if (searchTerm.startsWith('~~')) {
            const literal = searchTerm.slice(1);
            matcher = (text) => text.includes(literal);
        } else {
            const query = searchTerm.slice(1);
            matcher = (text) => fuzzyScore(query, text) >= 0;
        }
    } else if (searchTerm.startsWith('/') || searchTerm.startsWith('^')) {
        // Regex search: patterns starting with / or ^ are treated as regex
        try {
            // Remove leading / if present (^ is kept as it's part of the regex)
            const pattern = searchTerm.startsWith('/') ? searchTerm.slice(1) : searchTerm;
            const regex = new RegExp(pattern, 'i');
            matcher = (text) => regex.test(text);
        } catch {
            // Invalid regex, fall back to literal search
            matcher = (text) => text.includes(searchTerm);
        }
    } else if (searchTerm.includes('*') || searchTerm.includes('?')) {
        // test() is unanchored, so leading/trailing .* are dead weight:
        // stripping them turns a backtracking scan into a plain substring hunt.
        const pattern = wildcardToRegex(searchTerm).source.replace(/^\.\*/, '').replace(/\.\*$/, '');
        const regex = new RegExp(pattern || '(?:)', 'i');
        matcher = (text) => regex.test(text);
    } else if (!searchTerm.includes(' ')) {
        // Space-insensitive matching is a no-op for queries without spaces.
        matcher = (text) => text.includes(searchTerm);
    } else {
        // Plain search with space-insensitive matching
        const noSpaces = searchTerm.replace(/\s/g, '');
        matcher = (text) => text.includes(searchTerm) || text.replace(/\s/g, '').includes(noSpaces);
    }

    if (searchMatcherCache.size > 100) {
        searchMatcherCache.delete(searchMatcherCache.keys().next().value);
    }
    searchMatcherCache.set(searchTerm, matcher);
    return matcher;
}

// Fields computed once per blob so per-keystroke passes stay allocation-light:
// _lc for search, _slashes for folder-depth math.
function prepareDownloads(downloads) {
    for (const download of downloads) {
        let slashes = 0;
        for (let i = 0; i < download.Name.length; i++) {
            if (download.Name.charCodeAt(i) === 47) slashes++;
        }
        download._slashes = slashes;
        download._lc = download.Name.toLowerCase();
    }
    return downloads;
}

// Search pool: downloads matching the current query anywhere in the
// container (zero-byte files excluded, file-type filter NOT applied). Built
// once per query and shared by the type-count pass and the result view.
let searchPool = [];
let searchPoolQuery = null;

function buildSearchPool(searchTerm) {
    const matcher = makeSearchMatcher(searchTerm);
    searchPool = allDownloads.filter(d => d.Length > 0 && matcher(d._lc));
    searchPoolQuery = searchTerm;
}

function typeAllows(download) {
    return allFileTypesSelected
        || (activeFileTypes.size > 0 && activeFileTypes.has(getFileTypeInfo(download).name));
}

function filterByFileTypes(files) {
    if (allFileTypesSelected) return files;
    if (activeFileTypes.size === 0) return [];
    return files.filter(typeAllows);
}

// Initialize file type filters
function initializeFilters() {
    updateFileTypeFilterCounts();
}

// Update file type filter counts based on current search/filters
function updateFileTypeFilterCounts() {
    const searchTerm = document.getElementById('searchInput').value;
    
    const term = searchTerm.toLowerCase();
    let matchingFiles;
    if (term) {
        if (searchPoolQuery !== term) buildSearchPool(term);
        matchingFiles = searchPool;
    } else {
        matchingFiles = allDownloads.filter(d => d.Length > 0);
    }
    
    // Count file types in matching files
    const fileTypeCounts = {};
    matchingFiles.forEach(download => {
        const typeInfo = getFileTypeInfo(download);
        fileTypeCounts[typeInfo.name] = (fileTypeCounts[typeInfo.name] || 0) + 1;
    });
    
    const filterContainer = document.getElementById('fileTypeFilter');
    const prevScroll = filterContainer.scrollTop;
    filterContainer.innerHTML = '';
    
    // Alphabetical (not by count): the menu recomputes counts as the search
    // changes, so count-ordering would reshuffle the list while the user
    // reads it. Kind names are known words - predictable position wins.
    const sortedTypes = Object.entries(fileTypeCounts).sort((a, b) => a[0].localeCompare(b[0]));
    
    // Add Select All / Select None buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'dropdown-buttons';
    
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'dropdown-action-btn';
    selectAllBtn.textContent = 'All file types';
    selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        allFileTypesSelected = true;
        activeFileTypes.clear();
        updateFileTypeFilterCounts();
        displayDownloads();
        BlobExplorerAnalytics.filterChange(Array.from(activeFileTypes), sortedTypes.length);
    });
    
    const selectNoneBtn = document.createElement('button');
    selectNoneBtn.type = 'button';
    selectNoneBtn.className = 'dropdown-action-btn';
    selectNoneBtn.textContent = 'No file types';
    selectNoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        allFileTypesSelected = false;
        activeFileTypes.clear();
        updateFileTypeFilterCounts();
        displayDownloads();
        BlobExplorerAnalytics.filterChange([], sortedTypes.length);
    });
    
    buttonContainer.appendChild(selectAllBtn);
    buttonContainer.appendChild(selectNoneBtn);
    
    sortedTypes.forEach(([type, count]) => {
        const label = document.createElement('label');
        label.className = 'filter-option';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = type;
        checkbox.checked = allFileTypesSelected || activeFileTypes.has(type);
        
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                activeFileTypes.add(type);
                // If all types are now selected, reset to "all" state
                if (activeFileTypes.size >= sortedTypes.length) {
                    allFileTypesSelected = true;
                    activeFileTypes.clear();
                } else {
                    allFileTypesSelected = false;
                }
            } else {
                // If currently "all", populate with all types first then remove
                if (allFileTypesSelected) {
                    sortedTypes.forEach(([t]) => activeFileTypes.add(t));
                    allFileTypesSelected = false;
                }
                activeFileTypes.delete(type);
            }
            updateFilterButtonText();
            displayDownloads();
            BlobExplorerAnalytics.filterChange(Array.from(activeFileTypes), sortedTypes.length);
        });
        
        const text = document.createElement('span');
        text.textContent = `${type} (${count})`;
        
        label.appendChild(checkbox);
        label.appendChild(text);
        filterContainer.appendChild(label);
    });
    filterContainer.appendChild(buttonContainer);
    filterContainer.scrollTop = prevScroll;
    updateFilterButtonText();
}



// Update filter button text
function updateFilterButtonText() {
    const filterBtn = document.getElementById('filterBtnText');
    const count = activeFileTypes.size;
    
    if (allFileTypesSelected) {
        filterBtn.textContent = 'All file types';
    } else if (count === 0) {
        filterBtn.textContent = 'No file types';
    } else {
        const types = Array.from(activeFileTypes).sort((a, b) => a.localeCompare(b)).join(', ');
        filterBtn.textContent = count <= 2 ? types : `${count} types selected`;
    }
}

// Get all unique folder paths at all levels
function getAllFolderPaths() {
    const folderPaths = new Set();
    
    allDownloads.forEach(download => {
        const parts = download.Name.split('/');
        // Generate all folder paths (full paths, not just top level)
        for (let i = 1; i < parts.length; i++) {
            folderPaths.add(parts.slice(0, i).join('/'));
        }
    });
    
    return Array.from(folderPaths);
}

// Match folders against a regex pattern and return sorted results
function matchFolders(pattern, limit = 10, sortOrder = 'desc') {
    // Ensure pattern matches complete folder path by adding anchors if not present
    const adjustedPattern = pattern.includes('$') ? pattern : pattern + '(?:/|$)';
    const regex = new RegExp(adjustedPattern, 'i');
    const allFolders = getAllFolderPaths();
    
    // Filter folders that match the pattern (test against full path)
    // But only keep the shortest matching path (to avoid subfolders)
    const matchedPaths = new Map(); // folderName -> shortest path
    
    allFolders.forEach(folder => {
        if (regex.test(folder)) {
            // Extract the part that matches the pattern
            const match = folder.match(new RegExp(pattern, 'i'));
            if (match) {
                const matchedPart = folder.substring(0, match.index + match[0].length);
                
                // Keep only the shortest path for each folder name
                if (!matchedPaths.has(matchedPart) || folder.length < matchedPaths.get(matchedPart).length) {
                    matchedPaths.set(matchedPart, matchedPart);
                }
            }
        }
    });
    
    // If no folder matches, try matching against file paths and return parent folders
    if (matchedPaths.size === 0) {
        const fileRegex = new RegExp(pattern, 'i');
        allDownloads.forEach(download => {
            if (fileRegex.test(download.Name)) {
                // Get the parent folder path
                const parts = download.Name.split('/');
                const parentPath = parts.slice(0, -1).join('/');
                if (parentPath && !matchedPaths.has(parentPath)) {
                    matchedPaths.set(parentPath, parentPath);
                }
            }
        });
    }
    
    // Convert to array and sort
    const sorted = Array.from(matchedPaths.keys()).sort((a, b) => {
        return sortOrder === 'desc' ? b.localeCompare(a) : a.localeCompare(b);
    });
    
    // Return limited results
    return sorted.slice(0, limit);
}

// Render favorites section
function renderFavorites() {
    const favoritesContainer = document.getElementById('favoritesTree');
    favoritesContainer.innerHTML = '';
    
    // Render user's pinned favorites first
    renderUserFavorites(favoritesContainer);
    
    // Then render system favorites from config
    const favoritesConfig = getFavoritesConfig();
    favoritesConfig.forEach(favorite => {
        // Handle different favorite types from config
        if (favorite.type === 'search' || favorite.searchPattern) {
            // Search type: run a search query when clicked
            const query = favorite.query || favorite.searchPattern;
            if (!query) return;
            
            // Add label if provided
            if (favorite.label) {
                const labelEl = document.createElement('div');
                labelEl.className = 'favorite-label';
                labelEl.textContent = favorite.label;
                favoritesContainer.appendChild(labelEl);
            }
            
            // Add search item
            const searchEl = document.createElement('div');
            searchEl.className = 'favorite-item favorite-search';
            const searchInput = document.getElementById('searchInput');
            const searchQuery = query.startsWith('^') ? query : '^' + query;
            const isActive = searchInput && searchInput.value === searchQuery;
            if (isActive) {
                searchEl.classList.add('active');
            }
            
            searchEl.innerHTML = `<span class="icon-search" aria-hidden="true"></span> ${esc(favorite.displayName || favorite.label || 'Search')}`;
            makeKeyboardAccessible(searchEl, () => {
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = searchQuery;
                    const searchBar = searchInput.closest('.search-box');
                    if (searchBar) searchBar.classList.add('has-text');
                    currentPath = [];
                    applyFilters();
                }
            });
            
            favoritesContainer.appendChild(searchEl);
            return;
        }
        
        if (favorite.type === 'folder' && favorite.path) {
            // Folder type: navigate directly to a specific path
            if (favorite.label) {
                const labelEl = document.createElement('div');
                labelEl.className = 'favorite-label';
                labelEl.textContent = favorite.label;
                favoritesContainer.appendChild(labelEl);
            }
            
            const pathArray = Array.isArray(favorite.path) ? favorite.path : favorite.path.split('/');
            const folderName = pathArray[pathArray.length - 1] || favorite.label;
            
            const folderEl = document.createElement('div');
            folderEl.className = 'favorite-item';
            const isActive = JSON.stringify(currentPath) === JSON.stringify(pathArray);
            if (isActive) {
                folderEl.classList.add('active');
            }
            
            folderEl.innerHTML = `<span class="icon-folder" aria-hidden="true"></span> ${esc(folderName)}`;
            makeKeyboardAccessible(folderEl, () => {
                navigateToPath(pathArray);
            });
            
            favoritesContainer.appendChild(folderEl);
            return;
        }
        
        if (favorite.type === 'pattern' || favorite.pattern) {
            // Pattern type: auto-match folders using regex
            const pattern = favorite.pattern;
            if (!pattern) return;
            
            const matches = matchFolders(pattern, favorite.limit, favorite.sortOrder);
            
            if (matches.length > 0) {
                if (favorite.label) {
                    const labelEl = document.createElement('div');
                    labelEl.className = 'favorite-label';
                    labelEl.textContent = favorite.label;
                    favoritesContainer.appendChild(labelEl);
                }
                
                matches.forEach(folderPath => {
                    const folderName = folderPath.split('/').pop();
                    const pathArray = folderPath.split('/');
                    
                    const folderEl = document.createElement('div');
                    folderEl.className = 'favorite-item';
                    const isActive = JSON.stringify(currentPath) === JSON.stringify(pathArray);
                    if (isActive) {
                        folderEl.classList.add('active');
                    }
                    
                    folderEl.innerHTML = `<span class="icon-star" aria-hidden="true"></span> ${esc(folderName)}`;
                    makeKeyboardAccessible(folderEl, () => {
                        navigateToPath(pathArray);
                    });
                    
                    favoritesContainer.appendChild(folderEl);
                });
            }
            return;
        }
    });
}

// Render user's pinned favorites
function renderUserFavorites(container) {
    const userFavorites = getUserFavorites();
    const searchInput = document.getElementById('searchInput');
    const currentSearch = searchInput ? searchInput.value : '';
    
    // Add "My Pins" label
    const labelEl = document.createElement('div');
    labelEl.className = 'favorite-label';
    labelEl.textContent = 'Pinned views';
    container.appendChild(labelEl);
    
    // Add pinned items
    userFavorites.forEach(fav => {
        const itemEl = document.createElement('div');
        itemEl.className = 'favorite-item user-favorite';
        
        // Check if this favorite is currently active
        let isActive = false;
        if (fav.type === 'search') {
            isActive = currentSearch === fav.query;
        } else if (fav.type === 'folder') {
            isActive = JSON.stringify(currentPath) === JSON.stringify(fav.path);
        }
        if (isActive) {
            itemEl.classList.add('active');
        }
        
        const iconClass = fav.type === 'search' ? 'icon-search' : 'icon-pin';
        itemEl.innerHTML = `
            <span class="user-favorite-name" tabindex="0" role="button"><span class="${iconClass}" aria-hidden="true"></span> ${esc(fav.name)}</span>
            <button class="user-favorite-edit" data-id="${fav.id}" title="Edit" aria-label="Edit ${esc(fav.name)}"><span class="icon-edit" aria-hidden="true"></span></button>
        `;
        
        // Click to navigate (with keyboard support)
        const nameEl = itemEl.querySelector('.user-favorite-name');
        const navigateHandler = () => {
            if (fav.type === 'search') {
                const searchInput = document.getElementById('searchInput');
                searchInput.value = fav.query;
                const searchBar = searchInput.closest('.search-box');
                if (searchBar) searchBar.classList.add('has-text');
                currentPath = [];
                applyFilters();
                renderFavorites(); // Update active state
            } else if (fav.type === 'folder') {
                navigateToPath(fav.path);
            }
        };
        nameEl.addEventListener('click', navigateHandler);
        nameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigateHandler();
            }
        });
        
        // Edit button
        itemEl.querySelector('.user-favorite-edit').addEventListener('click', (e) => {
            e.stopPropagation();
            openPinModal('edit', fav);
        });
        
        container.appendChild(itemEl);
    });
    
    // Add "Save current view" button
    const addPinEl = document.createElement('div');
    addPinEl.className = 'favorite-item add-pin-item';
    addPinEl.innerHTML = `<span class="icon-pin" aria-hidden="true"></span> Pin current view…`;
    makeKeyboardAccessible(addPinEl, openPinForCurrentView);
    container.appendChild(addPinEl);
}

// Open the pin modal for adding or editing
function openPinModal(mode, data) {
    const modal = document.getElementById('pinModal');
    const titleEl = document.getElementById('pinModalTitle');
    const nameInput = document.getElementById('pinNameInput');
    const deleteBtn = document.getElementById('pinDeleteBtn');
    const typeIndicator = document.getElementById('pinTypeIndicator');
    
    modal.dataset.mode = mode;
    modal.dataset.editId = data.id || '';
    modal.dataset.type = data.type;
    modal.dataset.query = data.query || '';
    modal.dataset.path = data.path ? JSON.stringify(data.path) : '';
    
    if (mode === 'add') {
        titleEl.textContent = 'Pin current view';
        deleteBtn.style.display = 'none';
    } else {
        titleEl.textContent = 'Edit pin';
        deleteBtn.style.display = 'inline-block';
    }
    
    nameInput.value = data.name || '';
    
    // Show what's being pinned
    if (data.type === 'search') {
        typeIndicator.textContent = `Search: ${data.query}`;
    } else {
        typeIndicator.textContent = `Folder: ${data.path.join(' / ')}`;
    }
    
    modal.classList.add('active');
    
    // Store the element that triggered the modal for restoring focus
    modal._previouslyFocusedElement = document.activeElement;
    
    nameInput.focus();
    nameInput.select();
    
    // Set up focus trap
    setupFocusTrap(modal);
}

// Set up focus trap for modal dialogs
function setupFocusTrap(modal) {
    const focusableElements = modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    
    modal._focusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;
        
        if (e.shiftKey) {
            if (document.activeElement === firstFocusable) {
                e.preventDefault();
                lastFocusable.focus();
            }
        } else {
            if (document.activeElement === lastFocusable) {
                e.preventDefault();
                firstFocusable.focus();
            }
        }
    };
    
    modal.addEventListener('keydown', modal._focusTrapHandler);
}

function closePinModal() {
    const modal = document.getElementById('pinModal');
    modal.classList.remove('active');
    
    // Clean up focus trap
    if (modal._focusTrapHandler) {
        modal.removeEventListener('keydown', modal._focusTrapHandler);
    }
    
    // Restore focus to the element that opened the modal
    if (modal._previouslyFocusedElement) {
        modal._previouslyFocusedElement.focus();
    }
}

function savePinFromModal() {
    const modal = document.getElementById('pinModal');
    const nameInput = document.getElementById('pinNameInput');
    const name = nameInput.value.trim();
    
    if (!name) {
        showToast('Please enter a name');
        return;
    }
    
    const mode = modal.dataset.mode;
    const type = modal.dataset.type;
    
    if (mode === 'add') {
        const favorite = { type, name };
        if (type === 'search') {
            favorite.query = modal.dataset.query;
        } else {
            favorite.path = JSON.parse(modal.dataset.path);
        }
        addUserFavorite(favorite);
        showToast('Pinned');
    } else {
        const id = parseInt(modal.dataset.editId, 10);
        updateUserFavorite(id, { name });
        showToast('Pin updated');
    }
    
    closePinModal();
    renderFavorites();
}

function deletePinFromModal() {
    const modal = document.getElementById('pinModal');
    const id = parseInt(modal.dataset.editId, 10);
    deleteUserFavorite(id);
    showToast('Pin removed');
    closePinModal();
    renderFavorites();
}

// Navigate to path
function navigateToPath(path) {
    const previousPath = currentPath;
    currentPath = path;
    navDepth++;
    updateNavButtons();
    syncFolderTree();
    clearSelection();

    // Track folder navigation
    const folderPath = path.join('/');
    const folderName = path.length > 0 ? path[path.length - 1] : 'Home';
    BlobExplorerAnalytics.folderNavigate(folderPath, folderName);

    // Clear search when navigating to a folder
    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchInput.value) {
        searchInput.value = '';
        const searchBar = searchInput.closest('.search-box');
        if (searchBar) searchBar.classList.remove('has-text');
    }

    // Update browser history
    const url = new URL(window.location);
    url.searchParams.delete('q'); // Clear search query
    if (path.length > 0) {
        const pathString = path.join('/');
        url.searchParams.set('path', pathString);
    } else {
        url.searchParams.delete('path');
    }
    window.history.pushState({ path: path, search: '' }, '', url);

    renderFavorites();
    applyFilters();
    // Going up one level, keep the user's spot: pre-select (and scroll to)
    // the folder we just left, so j continues from there instead of the
    // top of the list.
    const leftFolder = previousPath.length === path.length + 1 &&
        path.every((seg, i) => seg === previousPath[i]) ? previousPath[path.length] : null;
    if (leftFolder) {
        const idx = viewItems.findIndex(it => it.type === 'folder' && it.name === leftFolder);
        if (idx >= 0) focusIndex(idx);
    }
    renderBreadcrumbs();
}

// Render breadcrumbs
function renderBreadcrumbs() {
    const breadcrumbsEl = document.getElementById('breadcrumbs');
    const searchTerm = document.getElementById('searchInput').value.trim();

    const homeCrumb = `<span class="breadcrumb crumb-home" tabindex="0" role="link" data-path="[]" aria-label="Home">${FL.home}<span>Home</span></span>`;

    if (searchTerm) {
        breadcrumbsEl.innerHTML = `${homeCrumb}<span class="breadcrumb search-crumb">Search results for “${esc(searchTerm)}”</span>`;
    } else {
        const segs = currentPath.map((seg, i) =>
            `<span class="breadcrumb" tabindex="0" role="link" data-path="${esc(JSON.stringify(currentPath.slice(0, i + 1)))}">${esc(seg)}</span>`
        ).join('');
        breadcrumbsEl.innerHTML = homeCrumb + segs;
    }

    breadcrumbsEl.querySelectorAll('.breadcrumb[data-path]').forEach(el => {
        const navigateHandler = () => navigateToPath(JSON.parse(el.dataset.path));
        el.addEventListener('click', navigateHandler);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigateHandler();
            }
        });
    });
    updateNavButtons();
}

// Apply filters
function applyFilters() {
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput.value.toLowerCase();
    
    // Update URL with search query
    const url = new URL(window.location);
    if (searchTerm) {
        url.searchParams.set('q', searchInput.value); // Use original case
        url.searchParams.delete('path'); // Clear path when searching
    } else {
        url.searchParams.delete('q');
        // Restore path if we have one
        if (currentPath.length > 0) {
            url.searchParams.set('path', currentPath.join('/'));
        }
    }
    window.history.replaceState({ path: currentPath, search: searchInput.value }, '', url);
    
    if (searchTerm) {
        // Searching replaces the folder view with the container-wide result
        // list, so the per-folder path pass is skipped entirely: one search
        // pass feeds the view, the type counts, and the analytics count.
        buildSearchPool(searchTerm);
        filteredDownloads = filterByFileTypes(searchPool);
    } else {
        const pathDepth = currentPath.length;
        const pathPrefix = pathDepth > 0 ? currentPath.join('/') + '/' : '';
        const inCurrentFolder = (download) => pathDepth > 0
            // Name = prefix + remainder; the remainder must hold no further slash.
            ? download.Name.startsWith(pathPrefix) && download._slashes - pathDepth <= 0
            : download._slashes === 0;
        filteredDownloads = allDownloads.filter(download => inCurrentFolder(download) && typeAllows(download));
    }
    
    updateFileTypeFilterCounts(); // Update dropdown counts
    displayDownloads();
}

// Sort files based on current sort option
function sortFiles(files) {
    const sorted = [...files];
    const nameOf = (f) => f.Name.split('/').pop().toLowerCase();
    const extOf = (f) => (getFileExtension(f.Url) || 'zzz');

    switch (sortBy) {
        case 'date-desc':
            sorted.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
            break;
        case 'date-asc':
            sorted.sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));
            break;
        case 'size-desc':
            sorted.sort((a, b) => b.Length - a.Length);
            break;
        case 'size-asc':
            sorted.sort((a, b) => a.Length - b.Length);
            break;
        case 'name-desc':
            sorted.sort((a, b) => nameOf(b).localeCompare(nameOf(a)));
            break;
        case 'type-asc':
            sorted.sort((a, b) => extOf(a).localeCompare(extOf(b)) || nameOf(a).localeCompare(nameOf(b)));
            break;
        case 'type-desc':
            sorted.sort((a, b) => extOf(b).localeCompare(extOf(a)) || nameOf(a).localeCompare(nameOf(b)));
            break;
        case 'name-asc':
        default:
            sorted.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
            break;
    }

    return sorted;
}

// Convert wildcard pattern to regex
function wildcardToRegex(pattern) {
    // Escape special regex characters except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Convert * to .* and ? to .
    const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(regexPattern, 'i');
}
// VS Code-style fuzzy match: query characters must appear in order
// (greedy earliest match — an optimal test for subsequence existence),
// scored by contiguity, word-boundary starts, and early position.
// Returns -1 when not a subsequence; higher-is-better otherwise.
// ~ is the mode sigil (~~ escapes a literal leading tilde); it exists
// only in the search box and never alters regex/wildcard/substring
// behavior for any other query — production pinned searches rely on those.
function fuzzyScore(query, text) {
    if (!query) return 0;
    let score = 0, ti = 0, prev = -2, streak = 0;
    for (const qc of query) {
        const found = text.indexOf(qc, ti);
        if (found === -1) return -1;
        const atBoundary = found === 0 || /[-_./ ]/.test(text[found - 1]) ||
            /\d/.test(text[found - 1]) !== /\d/.test(text[found]);
        if (found === prev + 1) {
            streak++;
        } else {
            streak = 1;
            if (atBoundary) score += 8;
            score -= Math.min(4, found - prev - 1); // scattered-gap penalty
        }
        score += streak * 2;
        prev = found;
        ti = found + 1;
    }
    return score - Math.round(prev / Math.max(text.length, 1) * 4);
}


// Helper: Check if a folder contains files matching the active file type filter (recursive)
// Also filters out folders with no non-zero byte files
function folderHasMatchingFiles(parentPath, folderName) {
    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    
    // Check if this folder's tree node has matching files
    const checkNode = (path) => {
        const node = folderTree.get(path);
        if (!node) return false;
        
        // Check files in this folder (excluding 0-byte files)
        const hasMatchingFile = node.files.some(download => {
            if (download.Length <= 0) return false;
            // If file type filter is active, check against it
            if (!allFileTypesSelected) {
                if (activeFileTypes.size === 0) return false;
                const typeInfo = getFileTypeInfo(download);
                return activeFileTypes.has(typeInfo.name);
            }
            return true; // All types selected, any non-zero file counts
        });
        
        if (hasMatchingFile) return true;
        
        // Recursively check subfolders
        for (const subfolder of node.folders) {
            const subfolderPath = path ? `${path}/${subfolder}` : subfolder;
            if (checkNode(subfolderPath)) return true;
        }
        
        return false;
    };
    
    return checkNode(folderPath);
}

// Build the current view (folders + files, or search hits) and window-render it
function displayDownloads() {
    const resultCount = document.getElementById('resultCount');
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();

    // Update breadcrumbs to reflect search state
    renderBreadcrumbs();
    syncSortHeaders();

    // If searching, show all matching files from anywhere
    if (searchTerm) {
        if (searchPoolQuery !== searchTerm) buildSearchPool(searchTerm);
        const filteredFiles = filterByFileTypes(searchPool);
        const sorted = sortFiles(filteredFiles);
        // Fuzzy queries lead with relevance: stable re-sort by score keeps
        // the column sort as the tie-break within equal scores.
        const fuzzyQ = searchTerm.startsWith('~') && !searchTerm.startsWith('~~') ? searchTerm.slice(1) : null;
        if (fuzzyQ) {
            // Match-in-the-file-name outweighs match-across-the-folder-path,
            // so ~installer ranks by name, not by lucky folder letters.
            const score = (name) => {
                const lower = name.toLowerCase();
                const base = lower.split('/').pop();
                return Math.max(fuzzyScore(fuzzyQ, lower), fuzzyScore(fuzzyQ, base) + 12, 0);
            };
            const scoreOf = new Map(filteredFiles.map(f => [f.Name, score(f.Name)]));
            sorted.sort((a, b) => scoreOf.get(b.Name) - scoreOf.get(a.Name));
        }
        resultCount.textContent = `${sorted.length.toLocaleString()} result${sorted.length !== 1 ? 's' : ''}`;
        setView(sorted.map(d => ({ type: 'file', data: d })), true,
            `<div class="no-results">${FL.empty}No results for “${esc(searchInputRaw())}”.</div>`);
        return;
    }

    // Use tree structure for O(1) folder navigation
    const pathKey = currentPath.join('/');
    const node = folderTree.get(pathKey);
    const empty = `<div class="no-results">${FL.empty}This folder is empty.</div>`;

    if (!node) {
        resultCount.textContent = '0 items';
        setView([], false, empty);
        return;
    }

    const folders = Array.from(node.folders);

    // Zero-byte files hidden, file-type filter applied (the search query
    // never reaches the folder view - applyFilters routes searching elsewhere).
    const files = filterByFileTypes(node.files.filter(d => d.Length > 0));

    // Filter folders that contain matching files (recursive check)
    const filteredFolders = folders.filter(folderName => folderHasMatchingFiles(pathKey, folderName));

    // Sort files
    const sortedFiles = sortFiles(files);

    // Windows 11 grouping: folders always form a group above the file group,
    // so a size or date sort never interpolates folders and files. Within its
    // group, the folder group orders by recursive size / newest descendant
    // date on the matching sort, otherwise alphabetically in the name
    const folderItems = filteredFolders.map(f => ({ type: 'folder', name: f, path: pathKey ? pathKey + '/' + f : f }));
    if (sortBy.startsWith('size') || sortBy.startsWith('date')) {
        const dir = sortBy.endsWith('desc') ? -1 : 1;
        const val = p => sortBy.startsWith('size') ? (folderSizes.get(p) || 0) : (folderDates.get(p) || 0);
        folderItems.sort((a, b) => (val(a.path) - val(b.path)) * dir || a.name.localeCompare(b.name));
    } else if (sortBy === 'name-desc') {
        folderItems.sort((a, b) => b.name.localeCompare(a.name));
    } else {
        // Type sorts: every folder is the same "File folder" type, so the
        // group stays alphabetical in both directions.
        folderItems.sort((a, b) => a.name.localeCompare(b.name));
    }
    const items = [...folderItems, ...sortedFiles.map(f => ({ type: 'file', data: f }))];

    resultCount.textContent = `${items.length.toLocaleString()} item${items.length !== 1 ? 's' : ''}`;
    setView(items, false, empty);
}

// ---------------------------------------------------------------------------
// Windowed rendering: only the visible slice (+overscan) of the current view
// is in the DOM. The list scrolls continuously and the scrollbar thumb
// conveys total length, so no pager is needed at 100K-file scale.
// Row geometry is arithmetic: 32px rows in list view, 108x100 tiles in tile
// view (keep listMetrics() in sync with styles.css).
// ---------------------------------------------------------------------------
function setView(items, fromSearch, emptyHtml) {
    viewItems = items;
    viewFromSearch = !!fromSearch;
    emptyMessage = emptyHtml || '';
    selectedRow = null;
    selectedKey = null;
    winStart = winEnd = -1;
    document.getElementById('tableRows').scrollTop = 0;
    renderWindow();
    syncSelectionUI();
}

function listMetrics() {
    const scroller = document.getElementById('tableRows');
    if (viewMode === 'tiles') {
        const usable = scroller.clientWidth - 20; // container padding: 10px each side
        const cols = Math.max(1, Math.floor((usable + 2) / 110)); // 108px tile + 2px gap
        return { cols, cellH: 102, padY: 10 };
    }
    // List rows are fixed-height; CSS owns the exact value (32px desktop,
    // 52px two-line rows at <=620px). Read it so windowing math can't drift.
    const rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10);
    return { cols: 1, cellH: Number.isFinite(rowH) && rowH > 0 ? rowH : 32, padY: 4 };
}

function makeRowEl(item) {
    if (item.type === 'folder') {
        const folderEl = document.createElement('div');
        folderEl.className = 'mrow is-folder';
        folderEl.setAttribute('role', 'listitem');
        folderEl.setAttribute('tabindex', '0');
        folderEl.dataset.path = item.path;
        folderEl.dataset.name = item.name;
        folderEl.title = item.name;
        folderEl.innerHTML = `
            <span class="m-name"><span class="m-icon">${FL.folder}</span><span class="m-name-text">${esc(item.name)}</span></span>
            <span class="m-date" aria-hidden="true">${folderDates.has(item.path) ? formatDate(new Date(folderDates.get(item.path)).toISOString()) : '—'}</span>
            <span class="m-type" aria-hidden="true">File folder</span>
            <span class="m-size" aria-hidden="true">${formatFileSize(folderSizes.get(item.path) || 0)}</span>
            <span class="m-act"></span>
        `;
        bindRow(folderEl, () => navigateToPath(item.path.split('/')));
        return folderEl;
    }
    const rowEl = createDownloadItemElement(item.data, viewFromSearch);
    bindRow(rowEl, () => triggerDownload(rowEl));
    return rowEl;
}

function itemKey(item) {
    return item.type === 'folder' ? item.path : item.data.Name;
}

function renderWindow() {
    const listEl = document.getElementById('tableRows');
    const N = viewItems.length;

    if (N === 0) {
        winStart = winEnd = -1;
        listEl.innerHTML = emptyMessage || `<div class="no-results">${FL.empty}This folder is empty.</div>`;
        return;
    }

    const m = listMetrics();
    const st = listEl.scrollTop;
    const vh = listEl.clientHeight;

    let start, end;
    if (m.cols === 1) {
        start = Math.max(0, Math.floor(st / m.cellH) - 5);
        end = Math.min(N, Math.ceil((st + vh) / m.cellH) + 5);
    } else {
        const tileRowFrom = Math.max(0, Math.floor((st - m.padY) / m.cellH) - 2);
        const tileRowTo = Math.floor((st + vh - m.padY) / m.cellH) + 3;
        start = Math.min(N, tileRowFrom * m.cols);
        end = Math.min(N, tileRowTo * m.cols);
    }

    if (start === winStart && end === winEnd) return;
    winStart = start;
    winEnd = end;

    const frag = document.createDocumentFragment();
    const top = document.createElement('div');
    const bottom = document.createElement('div');
    top.className = 'vspacer';
    bottom.className = 'vspacer';
    if (m.cols === 1) {
        top.style.height = start * m.cellH + 'px';
        bottom.style.height = (N - end) * m.cellH + 'px';
    } else {
        const tileRowsTotal = Math.ceil(N / m.cols);
        top.style.width = '100%';
        bottom.style.width = '100%';
        top.style.height = Math.floor(start / m.cols) * m.cellH + 'px';
        bottom.style.height = (tileRowsTotal - Math.ceil(end / m.cols)) * m.cellH + 'px';
    }
    frag.appendChild(top);
    for (let i = start; i < end; i++) frag.appendChild(makeRowEl(viewItems[i]));
    frag.appendChild(bottom);

    listEl.innerHTML = '';
    listEl.appendChild(frag);

    if (selectedKey) {
        const sel = listEl.querySelector(`.mrow[data-path="${CSS.escape(selectedKey)}"]`);
        if (sel) {
            sel.classList.add('selected');
            selectedRow = sel;
        } else {
            selectedRow = null;
        }
    }
}

function ensureIndexVisible(idx) {
    const listEl = document.getElementById('tableRows');
    const m = listMetrics();
    const line = m.cols === 1 ? idx : Math.floor(idx / m.cols);
    const top = m.padY + line * m.cellH;
    const bottom = top + m.cellH;
    const st = listEl.scrollTop;
    const vh = listEl.clientHeight;
    if (top < st + m.padY) listEl.scrollTop = top - m.padY;
    else if (bottom > st + vh - 8) listEl.scrollTop = bottom - vh + 8;
}

function focusIndex(idx) {
    if (idx < 0 || idx >= viewItems.length) return;
    ensureIndexVisible(idx);
    renderWindow();
    const key = itemKey(viewItems[idx]);
    const el = document.querySelector(`#tableRows .mrow[data-path="${CSS.escape(key)}"]`);
    if (el) el.focus();
}

function initializeVirtualScroll() {
    const listEl = document.getElementById('tableRows');
    let scheduled = false;
    listEl.addEventListener('scroll', () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            renderWindow();
        });
    }, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => renderWindow()).observe(listEl);
    }
}

// Row interaction: single click selects, double click opens (Explorer model);
// on touch devices a single tap opens.
function bindRow(rowEl, openFn) {
    if (IS_TOUCH) {
        rowEl.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openFn();
        });
    } else {
        rowEl.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            selectRow(rowEl);
        });
        rowEl.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            openFn();
        });
    }
}

// ---------------------------------------------------------------------------
// Selection + command bar + details pane
// ---------------------------------------------------------------------------
function selectRow(rowEl) {
    if (selectedRow && selectedRow !== rowEl) selectedRow.classList.remove('selected');
    selectedRow = rowEl;
    selectedKey = rowEl.dataset.path || null;
    rowEl.classList.add('selected');
    syncSelectionUI();
}

function clearSelection() {
    if (selectedRow) {
        selectedRow.classList.remove('selected');
        selectedRow = null;
    }
    selectedKey = null;
    syncSelectionUI();
}

function syncSelectionUI() {
    const status = document.getElementById('statusSelection');
    const cmdCopy = document.getElementById('cmdCopy');
    const cmdDownload = document.getElementById('cmdDownload');
    const isFile = selectedRow && !selectedRow.classList.contains('is-folder');
    if (status) status.textContent = selectedRow ? '1 item selected' : '';
    if (cmdCopy) cmdCopy.disabled = !isFile;
    if (cmdDownload) cmdDownload.disabled = !isFile;
    renderDetailsPane();
}

function triggerCopy(rowEl) {
    const btn = rowEl.querySelector('.copy-link-button');
    const url = btn ? btn.dataset.url : rowEl.dataset.url;
    const filePath = rowEl.dataset.path;
    if (!url || !filePath) return;
    const fileName = filePath.split('/').pop();
    BlobExplorerAnalytics.copyLink(fileName, filePath);
    copyToClipboard(url, btn, 'Link copied to clipboard');
}

function triggerDownload(rowEl) {
    const url = rowEl.dataset.url;
    const filePath = rowEl.dataset.path;
    if (!url || !filePath) return;
    const fileName = filePath.split('/').pop();
    const download = allDownloads.find(d => d.Name === filePath);
    const fileSize = download ? download.Length : 0;
    const typeInfo = download ? getFileTypeInfo(download) : { name: 'Unknown' };
    BlobExplorerAnalytics.download(fileName, filePath, fileSize, typeInfo.name);
    window.open(url, '_blank');
}

function renderDetailsPane() {
    const pane = document.getElementById('detailsPane');
    if (!pane || pane.hidden) return;
    const empty = document.getElementById('detailsEmpty');
    const body = document.getElementById('detailsBody');
    if (!selectedRow) {
        empty.hidden = false;
        body.hidden = true;
        body.innerHTML = '';
        return;
    }
    empty.hidden = true;
    body.hidden = false;
    const d = selectedRow.dataset;

    if (selectedRow.classList.contains('is-folder')) {
        const node = folderTree.get(d.path) || { folders: new Set(), files: [] };
        body.innerHTML = `
            <div class="details-ico">${FL.folder}</div>
            <div class="details-name">${esc(d.name)}</div>
            <div class="details-type">File folder</div>
            <dl>
                <div class="detail-row"><dt>Date modified</dt><dd>${folderDates.has(d.path) ? formatDate(new Date(folderDates.get(d.path)).toISOString()) : '—'}</dd></div>
                <div class="detail-row"><dt>Size</dt><dd>${formatFileSize(folderSizes.get(d.path) || 0)}</dd></div>
                <div class="detail-row"><dt>Location</dt><dd>${esc(currentPath.length ? '/' + currentPath.join('/') : '/ (root)')}</dd></div>
                <div class="detail-row"><dt>Contains</dt><dd>${node.folders.size} folder${node.folders.size !== 1 ? 's' : ''}, ${node.files.length} file${node.files.length !== 1 ? 's' : ''}</dd></div>
            </dl>
            <div class="detail-actions"><button type="button" id="detailOpen">${FL.open}<span>Open</span></button></div>
        `;
        body.querySelector('#detailOpen').addEventListener('click', () => navigateToPath(d.path.split('/')));
    } else {
        const typeInfo = getFileTypeInfo({ Url: d.url, Name: d.path, ContentType: '' });
        const location = d.path.includes('/') ? '/' + d.path.split('/').slice(0, -1).join('/') : '/ (root)';
        body.innerHTML = `
            <div class="details-ico" style="color:${typeInfo.color}">${typeInfo.icon}</div>
            <div class="details-name">${esc(d.name)}</div>
            <div class="details-type">${esc(d.type || typeInfo.name)}</div>
            <dl>
                <div class="detail-row"><dt>Date modified</dt><dd>${formatDate(d.date)}</dd></div>
                <div class="detail-row"><dt>Size</dt><dd>${formatFileSize(Number(d.length))}</dd></div>
                <div class="detail-row"><dt>Location</dt><dd>${esc(location)}</dd></div>
            </dl>
            <div class="detail-url">${esc(d.url)}</div>
            <div class="detail-actions">
                <button type="button" id="detailCopy">${FL.copy}<span>Copy link</span></button>
                <button type="button" id="detailDownload">${FL.download}<span>Download</span></button>
            </div>
        `;
        body.querySelector('#detailCopy').addEventListener('click', () => triggerCopy(selectedRow));
        body.querySelector('#detailDownload').addEventListener('click', () => triggerDownload(selectedRow));
    }
}

// ---------------------------------------------------------------------------
// Navigation pane folder tree
// ---------------------------------------------------------------------------
// The folder tree is an admin opt-in (config.json showFoldersNav or
// SHOW_FOLDERS_NAV=true); the sidebar's default contract is Home + Pinned.
function foldersNavEnabled() {
    return typeof window.APP_CONFIG !== 'undefined' && window.APP_CONFIG.showFoldersNav === true;
}

function renderFolderNav() {
    const section = document.querySelector('.nav-folders');
    const nav = document.getElementById('folderNav');
    if (!nav) return;
    const enabled = foldersNavEnabled();
    if (section) section.hidden = !enabled;
    nav.innerHTML = '';
    if (!enabled || !allDownloads.length) return;
    nav.appendChild(buildTreeLevel(''));
    markActiveTree();
}

function buildTreeLevel(pathKey) {
    const node = folderTree.get(pathKey);
    const frag = document.createDocumentFragment();
    if (!node || node.folders.size === 0) return frag;

    Array.from(node.folders).sort((a, b) => a.localeCompare(b)).forEach(name => {
        const childPath = pathKey ? pathKey + '/' + name : name;
        const childNode = folderTree.get(childPath);
        const hasChildren = childNode && childNode.folders.size > 0;

        const branch = document.createElement('div');
        branch.className = 'tree-branch';
        branch.dataset.path = childPath;
        branch.setAttribute('aria-expanded', treeExpanded.has(childPath) ? 'true' : 'false');

        const label = document.createElement('div');
        label.className = 'tree-label';
        label.setAttribute('role', 'treeitem');
        label.tabIndex = 0;
        label.innerHTML = `${FL.folder}<span class="fav-name">${name}</span>`;
        label.addEventListener('click', () => {
            if (hasChildren && !treeExpanded.has(childPath)) toggleTreeBranch(childPath);
            navigateToPath(childPath.split('/'));
        });
        label.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); label.click(); }
        });
        branch.appendChild(label);

        if (hasChildren) {
            const twisty = document.createElement('button');
            twisty.type = 'button';
            twisty.className = 'tree-twisty';
            twisty.setAttribute('aria-label', (treeExpanded.has(childPath) ? 'Collapse ' : 'Expand ') + name);
            twisty.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7 5l-4 3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            twisty.addEventListener('click', (e) => { e.stopPropagation(); toggleTreeBranch(childPath); });
            branch.appendChild(twisty);

            if (treeExpanded.has(childPath)) {
                const kids = document.createElement('div');
                kids.className = 'tree-children';
                kids.appendChild(buildTreeLevel(childPath));
                branch.appendChild(kids);
            }
        }
        frag.appendChild(branch);
    });
    return frag;
}

function toggleTreeBranch(pathKey) {
    if (treeExpanded.has(pathKey)) treeExpanded.delete(pathKey);
    else treeExpanded.add(pathKey);
    saveTreeExpanded();
    renderFolderNav();
}

function syncFolderTree() {
    let acc = '';
    currentPath.forEach(seg => {
        acc = acc ? acc + '/' + seg : seg;
        treeExpanded.add(acc);
    });
    saveTreeExpanded();
    renderFolderNav();
}

function markActiveTree() {
    const key = currentPath.join('/');
    const homeEl = document.getElementById('homeLink');
    if (homeEl) homeEl.classList.toggle('active', !key);
    document.querySelectorAll('#folderNav .tree-label').forEach(l => l.classList.remove('active'));
    if (!key) return;
    const active = document.querySelector(`#folderNav .tree-branch[data-path="${CSS.escape(key)}"] > .tree-label`);
    if (active) active.classList.add('active');
}

// ---------------------------------------------------------------------------
// View modes, sort headers, explorer chrome wiring
// ---------------------------------------------------------------------------
function applyViewMode() {
    const card = document.getElementById('downloadList');
    if (!card) return;
    card.classList.toggle('tiles', viewMode === 'tiles');
    const bList = document.getElementById('viewListBtn');
    const bTiles = document.getElementById('viewTilesBtn');
    bList.classList.toggle('active', viewMode === 'list');
    bList.setAttribute('aria-pressed', String(viewMode === 'list'));
    bTiles.classList.toggle('active', viewMode === 'tiles');
    bTiles.setAttribute('aria-pressed', String(viewMode === 'tiles'));
    renderWindow(); // window geometry differs between rows and tiles
}

function applyDetailsPane() {
    const pane = document.getElementById('detailsPane');
    if (!pane) return;
    pane.hidden = !detailsOpen;
    const toggle = document.getElementById('detailsToggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(detailsOpen));
    renderDetailsPane();
}

function updateNavButtons() {
    const up = document.getElementById('upButton');
    const back = document.getElementById('backButton');
    if (up) up.disabled = currentPath.length === 0;
    if (back) back.disabled = navDepth === 0;
}

function syncSortHeaders() {
    document.querySelectorAll('.list-head .col[data-sort]').forEach(col => {
        const key = col.dataset.sort;
        const active = sortBy.startsWith(key);
        col.classList.toggle('sorted', active);
        col.classList.toggle('desc', active && sortBy.endsWith('-desc'));
        col.setAttribute('aria-sort', active ? (sortBy.endsWith('-desc') ? 'descending' : 'ascending') : 'none');
    });
}

function applySort(value) {
    sortBy = value;
    localStorage.setItem('explorerSort', sortBy);
    const sel = document.getElementById('sortBy');
    if (sel) sel.value = sortBy;
    syncSortHeaders();
    displayDownloads();
}

function cycleSort(key) {
    const next = { name: 'name-asc', date: 'date-desc', size: 'size-desc', type: 'type-asc' };
    const flip = { 'name-asc': 'name-desc', 'name-desc': 'name-asc', 'date-desc': 'date-asc', 'date-asc': 'date-desc', 'size-desc': 'size-asc', 'size-asc': 'size-desc', 'type-asc': 'type-desc', 'type-desc': 'type-asc' };
    applySort(sortBy.startsWith(key) ? flip[sortBy] : next[key]);
}

function initExplorerChrome() {
    applyViewMode();
    applyDetailsPane();
    updateNavButtons();
    syncSortHeaders();
    syncSelectionUI();

    document.getElementById('viewListBtn').addEventListener('click', () => {
        viewMode = 'list';
        localStorage.setItem('explorerView', 'list');
        applyViewMode();
    });
    document.getElementById('viewTilesBtn').addEventListener('click', () => {
        viewMode = 'tiles';
        localStorage.setItem('explorerView', 'tiles');
        applyViewMode();
    });
    document.getElementById('detailsToggle').addEventListener('click', () => {
        detailsOpen = !detailsOpen;
        localStorage.setItem('explorerDetails', detailsOpen ? 'on' : 'off');
        applyDetailsPane();
    });
    document.getElementById('cmdCopy').addEventListener('click', () => {
        if (selectedRow && !selectedRow.classList.contains('is-folder')) triggerCopy(selectedRow);
    });
    document.getElementById('cmdDownload').addEventListener('click', () => {
        if (selectedRow && !selectedRow.classList.contains('is-folder')) triggerDownload(selectedRow);
    });
    document.getElementById('cmdPin').addEventListener('click', openPinForCurrentView);
    document.getElementById('backButton').addEventListener('click', () => history.back());
    document.getElementById('upButton').addEventListener('click', () => {
        if (currentPath.length) navigateToPath(currentPath.slice(0, -1));
    });
    document.querySelectorAll('.list-head .col[data-sort]').forEach(col => {
        col.addEventListener('click', () => cycleSort(col.dataset.sort));
    });
    document.getElementById('tableRows').addEventListener('focusin', (e) => {
        const row = e.target.closest('.mrow');
        if (row) selectRow(row);
    });
}

// ============================================================================
// UI Initialization Functions
// ============================================================================

// Toast notification helper
function showToast(message) {
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
}

// Open the pin modal for the current folder or query
function openPinForCurrentView() {
    const searchInput = document.getElementById('searchInput');
    const searchQuery = searchInput ? searchInput.value.trim() : '';

    if (searchQuery) {
        openPinModal('add', { type: 'search', query: searchQuery, name: searchQuery });
    } else if (currentPath.length > 0) {
        const folderName = currentPath[currentPath.length - 1];
        openPinModal('add', { type: 'folder', path: [...currentPath], name: folderName });
    } else {
        showToast('Open a folder or run a query first');
    }
}


// Copy text to clipboard with button feedback
async function copyToClipboard(text, button, successMessage) {
    const feedback = () => {
        if (button) {
            const original = button.innerHTML;
            button.classList.add('copied');
            button.innerHTML = FL.check;
            setTimeout(() => {
                button.classList.remove('copied');
                button.innerHTML = original;
            }, 1500);
        }
        if (successMessage) showToast(successMessage);
    };

    try {
        await navigator.clipboard.writeText(text);
        feedback();
    } catch {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();

        try {
            document.execCommand('copy');
            feedback();
        } catch {
            showToast('Failed to copy');
        }

        document.body.removeChild(textArea);
    }
}

// Initialize theme toggle button (theme is already set by inline script in <head>)
function initializeTheme() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    
    darkModeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        BlobExplorerAnalytics.themeChange(newTheme);
    });
}

// Initialize search functionality
function initializeSearch(updateClearButtonVisibility) {
    const searchInput = document.getElementById('searchInput');
    const clearButton = document.getElementById('clearSearch');
    
    let searchTimeout;
    let searchTrackTimeout;
    searchInput.addEventListener('input', () => {
        updateClearButtonVisibility();
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(applyFilters, 300);
        
        // Track search queries (debounced longer to capture final query)
        clearTimeout(searchTrackTimeout);
        searchTrackTimeout = setTimeout(() => {
            const query = searchInput.value.trim();
            if (query.length >= 2) {
                BlobExplorerAnalytics.search(query, filteredDownloads.length);
            }
        }, 1500);
    });
    
    clearButton.addEventListener('click', () => {
        searchInput.value = '';
        updateClearButtonVisibility();
        applyFilters();
    });
    
    // Logo click - navigate to home (with keyboard support)
    const headerBrand = document.getElementById('headerBrand');
    const goHome = () => {
        searchInput.value = '';
        updateClearButtonVisibility();
        navigateToPath([]);
    };
    headerBrand.addEventListener('click', goHome);
    headerBrand.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            goHome();
        }
    });
    
    // Home link click - navigate to home (with keyboard support)
    const homeLink = document.getElementById('homeLink');
    homeLink.addEventListener('click', goHome);
    homeLink.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            goHome();
        }
    });
}

// Initialize sort dropdown (cycleSort keeps its value in sync)
function initializeSortSelect() {
    const sel = document.getElementById('sortBy');
    sel.value = sortBy;
    sel.addEventListener('change', (e) => applySort(e.target.value));
}

// Initialize file type filter dropdown
function initializeFilterDropdown() {
    const filterDropdownBtn = document.getElementById('fileTypeFilterBtn');
    const filterDropdown = document.getElementById('fileTypeFilter');
    
    filterDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = filterDropdown.classList.toggle('active');
        filterDropdownBtn.setAttribute('aria-expanded', isOpen);
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-dropdown')) {
            filterDropdown.classList.remove('active');
            filterDropdownBtn.setAttribute('aria-expanded', 'false');
        }
    });
    
    // Prevent dropdown from closing when clicking inside
    filterDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

// Desktop navigation-pane collapse. The preference persists across visits;
// mobile (<=768px) keeps the slide-over and ignores this state.
function setNavOpen(open, moveFocus = true) {
    navOpen = open;
    localStorage.setItem('explorerNav', open ? 'on' : 'off');
    document.querySelector('.explorer').classList.toggle('nav-collapsed', !open);
    document.getElementById('navCollapse').setAttribute('aria-expanded', String(open));
    if (moveFocus) {
        const target = document.getElementById(open ? 'navCollapse' : 'navRestore');
        if (target) target.focus();
    }
    renderWindow(); // tile column count depends on scroller width
}
// Initialize mobile sidebar
function initializeSidebar() {
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    document.getElementById('navCollapse').addEventListener('click', () => setNavOpen(false));
    document.getElementById('navRestore').addEventListener('click', () => setNavOpen(true));
    if (!navOpen) {
        document.querySelector('.explorer').classList.add('nav-collapsed');
        document.getElementById('navCollapse').setAttribute('aria-expanded', 'false');
    }
    
    function openSidebar() {
        sidebar.classList.add('active');
        sidebarOverlay.classList.add('active');
        sidebarToggle.classList.add('active');
        sidebarToggle.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
    }
    
    function closeSidebar() {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
        sidebarToggle.classList.remove('active');
        sidebarToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }
    
    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.contains('active') ? closeSidebar() : openSidebar();
    });
    
    sidebarOverlay.addEventListener('click', closeSidebar);
    
    // Close sidebar when navigating on mobile
    sidebar.addEventListener('click', (e) => {
        if (e.target.closest('.tree-label') || e.target.closest('.favorite-item') || e.target.closest('#homeLink')) {
            if (window.innerWidth <= 768) {
                closeSidebar();
            }
        }
    });
    
    return { openSidebar, closeSidebar };
}

// Initialize back to top button
function initializeBackToTop() {
    const backToTopBtn = document.getElementById('backToTop');
    const listEl = document.getElementById('tableRows');

    function checkScrollPosition() {
        backToTopBtn.classList.toggle('show', listEl.scrollTop > 300);
    }

    listEl.addEventListener('scroll', checkScrollPosition, { passive: true });

    backToTopBtn.addEventListener('click', () => {
        listEl.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

// Initialize help modal
function initializeHelpModal() {
    const helpButton = document.getElementById('helpButton');
    const helpModal = document.getElementById('helpModal');
    const helpModalClose = document.getElementById('helpModalClose');
    
    const openHelpModal = () => {
        helpModal._previouslyFocusedElement = document.activeElement;
        helpModal.classList.add('active');
        helpModalClose.focus();
        setupFocusTrap(helpModal);
    };
    
    const closeHelpModal = () => {
        helpModal.classList.remove('active');
        if (helpModal._focusTrapHandler) {
            helpModal.removeEventListener('keydown', helpModal._focusTrapHandler);
        }
        if (helpModal._previouslyFocusedElement) {
            helpModal._previouslyFocusedElement.focus();
        }
    };
    
    helpButton.addEventListener('click', openHelpModal);
    helpModalClose.addEventListener('click', closeHelpModal);
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) closeHelpModal();
    });
    
    // Initialize tab switching
    initializeHelpTabs(helpModal);
    
    return { helpModal, closeHelpModal };
}

// Initialize help modal tabs
function initializeHelpTabs(helpModal) {
    const tabs = helpModal.querySelectorAll('.help-tab');
    const tabContents = helpModal.querySelectorAll('.help-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Deactivate all tabs
            tabs.forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            
            // Hide all content
            tabContents.forEach(content => {
                content.classList.remove('active');
            });
            
            // Activate clicked tab
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            
            // Show corresponding content
            const targetId = tab.getAttribute('aria-controls');
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
        
        // Keyboard navigation for tabs
        tab.addEventListener('keydown', (e) => {
            const tabList = Array.from(tabs);
            const currentIndex = tabList.indexOf(tab);
            
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const nextIndex = e.key === 'ArrowRight' 
                    ? (currentIndex + 1) % tabList.length
                    : (currentIndex - 1 + tabList.length) % tabList.length;
                tabList[nextIndex].click();
                tabList[nextIndex].focus();
            }
        });
    });
}

// Initialize pin modal
function initializePinModal() {
    const pinModal = document.getElementById('pinModal');
    const pinModalClose = document.getElementById('pinModalClose');
    const pinSaveBtn = document.getElementById('pinSaveBtn');
    const pinCancelBtn = document.getElementById('pinCancelBtn');
    const pinDeleteBtn = document.getElementById('pinDeleteBtn');
    const pinNameInput = document.getElementById('pinNameInput');
    
    pinModalClose.addEventListener('click', closePinModal);
    pinCancelBtn.addEventListener('click', closePinModal);
    pinSaveBtn.addEventListener('click', savePinFromModal);
    pinDeleteBtn.addEventListener('click', deletePinFromModal);
    
    pinModal.addEventListener('click', (e) => {
        if (e.target === pinModal) closePinModal();
    });
    
    // Save on Enter key
    pinNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            savePinFromModal();
        } else if (e.key === 'Escape') {
            closePinModal();
        }
    });
}

// Initialize keyboard shortcuts — the full power-key layer.
// Arrows and vim-style j/k move rows; Enter and l open; h and Backspace
// go up; Home/End jump; PageUp/PageDown scroll; / focuses query; ? opens help.
function initializeKeyboardShortcuts(searchInput, helpModal, closeHelpModal, closeSidebar, closeSettingsModal, updateClearButtonVisibility) {
    const sidebar = document.getElementById('sidebar');
    const pinModal = document.getElementById('pinModal');
    const settingsModal = document.getElementById('settingsModal');

    function anyModalActive() {
        return pinModal.classList.contains('active')
            || helpModal.classList.contains('active')
            || settingsModal.classList.contains('active');
    }

    function moveRow(dir) {
        const N = viewItems.length;
        if (!N) return;
        let idx = -1;
        if (selectedKey) idx = viewItems.findIndex(it => itemKey(it) === selectedKey);
        const next = idx === -1
            ? (dir > 0 ? 0 : N - 1)
            : Math.min(N - 1, Math.max(0, idx + dir));
        focusIndex(next);
    }

    function jumpRow(idx) {
        focusIndex(idx);
    }

    function scrollPage(dir) {
        const listEl = document.getElementById('tableRows');
        listEl.scrollBy({ top: dir * (listEl.clientHeight - 64), behavior: 'smooth' });
    }

    function openRow(rowEl) {
        if (!rowEl) return false;
        if (rowEl.classList.contains('is-folder')) {
            navigateToPath(rowEl.dataset.path.split('/'));
            return true;
        }
        triggerDownload(rowEl);
        return true;
    }

    // Two-key sort chord: comma arms a sort flyout above the
    // status bar; the next key applies the sort (uppercase reverses).
    const sortHint = document.getElementById('sortHint');
    const SORT_CHORD_KEYS = {
        a: 'name-asc', A: 'name-desc',
        e: 'type-asc', E: 'type-desc',
        m: 'date-asc', M: 'date-desc',
        s: 'size-asc', S: 'size-desc'
    };
    let sortPending = false;
    let sortHideTimer = null;
    function showSortHint() {
        sortPending = true;
        sortHint.hidden = false;
        clearTimeout(sortHideTimer);
        sortHideTimer = setTimeout(hideSortHint, 5000);
    }
    function hideSortHint() {
        sortPending = false;
        sortHint.hidden = true;
        clearTimeout(sortHideTimer);
    }
    document.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
        // Enter inside the search box: commit the query and hand focus back
        // to the page, so the vim keys and sort chords work immediately.
        if (e.key === 'Enter' && active === searchInput && !anyModalActive()) {
            e.preventDefault();
            applyFilters();
            searchInput.blur();
            return;
        }

        // Explorer command chords
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !typing) {
            if (e.key === 'c' || e.key === 'C') {
                if (selectedRow && !selectedRow.classList.contains('is-folder')) {
                    e.preventDefault();
                    triggerCopy(selectedRow);
                }
                return;
            }
            if (e.key === 'p' || e.key === 'P') {
                e.preventDefault();
                openPinForCurrentView();
                return;
            }
            if (e.key === 'b' || e.key === 'B') {
                e.preventDefault();
                setNavOpen(!navOpen);
                return;
            }
        }
        if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault();
            history.back();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // "/" - focus search
        if (e.key === '/' && !typing && !anyModalActive()) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
            return;
        }

        // Escape - close modal / sidebar, or clear the query
        if (e.key === 'Escape') {
            if (sortPending) {
                hideSortHint();
            } else if (pinModal.classList.contains('active')) {
                closePinModal();
            } else if (helpModal.classList.contains('active')) {
                closeHelpModal();
            } else if (settingsModal.classList.contains('active')) {
                closeSettingsModal();
            } else if (sidebar.classList.contains('active')) {
                closeSidebar();
            } else if (searchInput.value && !typing) {
                searchInput.value = '';
                updateClearButtonVisibility();
                applyFilters();
                searchInput.blur();
            } else if (typing) {
                document.activeElement.blur();
            }
            return;
        }

        if (anyModalActive() || typing) return;

        if (e.key === '?') {
            e.preventDefault();
            document.getElementById('helpButton').click();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveRow(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveRow(-1);
            return;
        }
        if (e.key === 'Home') {
            e.preventDefault();
            jumpRow(0);
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            jumpRow(viewItems.length - 1);
            return;
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            scrollPage(1);
            return;
        }
        if (e.key === 'PageUp') {
            e.preventDefault();
            scrollPage(-1);
            return;
        }
        if (e.key === 'Backspace') {
            if (currentPath.length) {
                e.preventDefault();
                navigateToPath(currentPath.slice(0, -1));
            }
            return;
        }
        // Sort-chord resolution: while the flyout is up the next key picks
        // the sort; any other key cancels. Bare
        // modifier keydowns pass through untouched - Shift arrives as its
        // own keydown before the uppercase sort letter, so cancelling on it
        // would break Shift+A (etc.) on a physical keyboard.
        if (sortPending) {
            if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' ||
                e.key === 'Meta' || e.key === 'CapsLock' || e.key === 'AltGraph') return;
            e.preventDefault();
            hideSortHint();
            if (SORT_CHORD_KEYS[e.key]) applySort(SORT_CHORD_KEYS[e.key]);
            return;
        }
        if (e.key === ',') {
            e.preventDefault();
            showSortHint();
            return;
        }
        // Vim-style bindings (all suppressed while typing or when a modal is up).
        // j/k mirror the arrow keys; l enters the selected folder (no-op on a
        // file); h goes up one level.
        if (e.key === 'j' || e.key === 'J') {
            e.preventDefault();
            moveRow(1);
            return;
        }
        if (e.key === 'k' || e.key === 'K') {
            e.preventDefault();
            moveRow(-1);
            return;
        }
        if (e.key === 'l' || e.key === 'L') {
            if (selectedRow && selectedRow.classList.contains('is-folder')) {
                e.preventDefault();
                openRow(selectedRow);
            }
            return;
        }
        if (e.key === 'h' || e.key === 'H') {
            if (currentPath.length) {
                e.preventDefault();
                navigateToPath(currentPath.slice(0, -1));
            }
            return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            const rowEl = active && active.closest ? active.closest('.mrow') : null;
            if (rowEl) {
                e.preventDefault();
                openRow(rowEl);
            }
            return;
        }
    });
}

// Initialize copy button handlers (event delegation)
function initializeCopyHandlers() {
    // Link copy button handler (event delegation)
    document.addEventListener('click', (e) => {
        const copyBtn = e.target.closest('.copy-link-button');
        if (copyBtn) {
            e.preventDefault();
            e.stopPropagation();
            copyToClipboard(copyBtn.dataset.url, copyBtn, 'Link copied to clipboard');
        }
    });

    // Download button handler (event delegation)
    document.addEventListener('click', (e) => {
        const downloadBtn = e.target.closest('.download-button');
        if (downloadBtn) {
            e.preventDefault();
            e.stopPropagation();
            const fakeRow = { dataset: { url: downloadBtn.dataset.url, path: downloadBtn.dataset.path } };
            triggerDownload(fakeRow);
        }
    });
}

// Initialize URL state from query parameters
function initializeUrlState(searchInput, updateClearButtonVisibility) {
    const urlParams = new URLSearchParams(window.location.search);
    const pathParam = urlParams.get('path');
    const searchParam = urlParams.get('q');
    
    if (searchParam) {
        searchInput.value = searchParam;
        updateClearButtonVisibility();
        currentPath = [];
    } else if (pathParam) {
        currentPath = pathParam.split('/').filter(p => p.length > 0);
    }
    
    // Track initial page view
    BlobExplorerAnalytics.pageView();
    
    // Set initial history state
    window.history.replaceState({ path: currentPath, search: searchInput.value }, '', window.location);
    
    // Handle browser back/forward buttons
    window.addEventListener('popstate', (event) => {
        if (event.state) {
            currentPath = event.state.path || [];
            searchInput.value = event.state.search || '';
            updateClearButtonVisibility();
            
            renderFavorites();
            applyFilters();
            renderBreadcrumbs();
        }
    });
}

// ============================================================================
// Custom Storage URL Feature
// ============================================================================

const CUSTOM_URL_KEY = 'customStorageUrl';

// Check if custom URL feature is enabled
function isCustomUrlEnabled() {
    return typeof window.APP_CONFIG !== 'undefined' && window.APP_CONFIG.allowCustomUrl === true;
}

// Get stored custom URL from localStorage
function getCustomUrl() {
    try {
        return localStorage.getItem(CUSTOM_URL_KEY) || '';
    } catch (e) {
        console.error('Failed to get custom URL:', e);
        return '';
    }
}

// Save custom URL to localStorage
function saveCustomUrl(url) {
    try {
        if (url) {
            localStorage.setItem(CUSTOM_URL_KEY, url);
        } else {
            localStorage.removeItem(CUSTOM_URL_KEY);
        }
    } catch (e) {
        console.error('Failed to save custom URL:', e);
    }
}

// Fetch blobs from a custom Azure Blob Storage URL (client-side)
async function fetchBlobsFromUrl(baseUrl, onProgress) {
    const blobs = [];
    let marker = null;
    let pageNum = 0;
    const maxResults = 5000;
    
    // Ensure URL doesn't have trailing slash
    baseUrl = baseUrl.replace(/\/$/, '');
    
    // Check if we need to use the CORS proxy
    // The proxy is needed when fetching from a different origin
    const currentOrigin = window.location.origin;
    const targetUrl = new URL(baseUrl);
    const needsProxy = targetUrl.origin !== currentOrigin;
    
    // Convert Azure URL to proxy URL if needed
    // Example: https://account.blob.core.windows.net/container 
    //       -> /api/blob-proxy/account.blob.core.windows.net/container
    const getProxiedUrl = (url) => {
        if (!needsProxy) return url;
        const parsed = new URL(url);
        // Only proxy Azure Blob Storage URLs
        if (!parsed.hostname.endsWith('.blob.core.windows.net')) {
            throw new Error('Only Azure Blob Storage URLs are supported');
        }
        return `/api/blob-proxy/${parsed.hostname}${parsed.pathname}${parsed.search}`;
    };
    
    while (true) {
        pageNum++;
        let url = `${baseUrl}?restype=container&comp=list&maxresults=${maxResults}`;
        if (marker) {
            url += `&marker=${encodeURIComponent(marker)}`;
        }
        
        if (onProgress) {
            onProgress(`Fetching page ${pageNum}... (${blobs.length} items so far)`);
        }
        
        const fetchUrl = getProxiedUrl(url);
        const response = await fetch(fetchUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch blob list: ${response.status} ${response.statusText}`);
        }
        
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        
        // Check for parse errors
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) {
            throw new Error('Invalid XML response from storage');
        }
        
        // Extract blobs
        const blobElements = xmlDoc.querySelectorAll('Blob');
        blobElements.forEach(blobEl => {
            const name = blobEl.querySelector('Name')?.textContent || '';
            const props = blobEl.querySelector('Properties');
            
            if (name) {
                const encodedName = name.split('/').map(part => encodeURIComponent(part)).join('/');
                blobs.push({
                    Name: name,
                    Url: `${baseUrl}/${encodedName}`,
                    Length: parseInt(props?.querySelector('Content-Length')?.textContent || '0', 10),
                    LastModified: props?.querySelector('Last-Modified')?.textContent || '',
                    ContentType: props?.querySelector('Content-Type')?.textContent || ''
                });
            }
        });
        
        // Check for next page
        const nextMarker = xmlDoc.querySelector('NextMarker')?.textContent;
        if (!nextMarker) {
            break;
        }
        marker = nextMarker;
    }
    
    return blobs;
}

// Load data from custom URL
async function loadDataFromCustomUrl(customUrl) {
    const loadingEl = document.getElementById('tableRows');
    
    try {
        loadingEl.innerHTML = '<div class="loading">Connecting to storage...</div>';
        
        const blobs = await fetchBlobsFromUrl(customUrl, (status) => {
            loadingEl.innerHTML = `<div class="loading">${status}</div>`;
        });
        
        if (blobs.length === 0) {
            throw new Error('No blobs found in storage container');
        }
        
        // Clear existing data
        allDownloads = prepareDownloads(blobs);
        filteredDownloads = [...allDownloads];
        
        // Rebuild optimized data structures
        buildFolderTree();
        
        // Cache the data
        await cacheData({ downloads: blobs, timestamp: Date.now(), customUrl: customUrl });
        
        // Reset to home and re-render
        currentPath = [];
        initializeFilters();
        renderFavorites();
        displayDownloads();
        
        // Update stamped display + header fields
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = 'just now';
            lastUpdatedEl.title = 'Last updated ' + new Date().toLocaleString();
        }
        renderFolderNav();
        
        return { success: true, count: blobs.length };
        
    } catch (error) {
        console.error('Error loading from custom URL:', error);
        throw error;
    }
}

// Initialize settings modal
function initializeSettingsModal() {
    const settingsButton = document.getElementById('settingsButton');
    const settingsModal = document.getElementById('settingsModal');
    const settingsModalClose = document.getElementById('settingsModalClose');
    const customUrlInput = document.getElementById('customUrlInput');
    const settingsStatus = document.getElementById('settingsStatus');
    const loadBtn = document.getElementById('settingsLoadBtn');
    const resetBtn = document.getElementById('settingsResetBtn');
    
    // Show settings button if feature is enabled
    if (isCustomUrlEnabled()) {
        settingsButton.style.display = 'flex';
    }
    
    // Load saved URL
    customUrlInput.value = getCustomUrl();
    
    const showStatus = (type, message) => {
        settingsStatus.hidden = false;
        settingsStatus.className = 'settings-status ' + type;
        settingsStatus.textContent = message;
    };
    
    const hideStatus = () => {
        settingsStatus.hidden = true;
    };
    
    const openSettingsModal = () => {
        settingsModal._previouslyFocusedElement = document.activeElement;
        settingsModal.classList.add('active');
        settingsModalClose.focus();
        setupFocusTrap(settingsModal);
        hideStatus();
    };
    
    const closeSettingsModal = () => {
        settingsModal.classList.remove('active');
        if (settingsModal._focusTrapHandler) {
            settingsModal.removeEventListener('keydown', settingsModal._focusTrapHandler);
        }
        if (settingsModal._previouslyFocusedElement) {
            settingsModal._previouslyFocusedElement.focus();
        }
    };
    
    settingsButton.addEventListener('click', openSettingsModal);
    settingsModalClose.addEventListener('click', closeSettingsModal);
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
    });
    
    // Handle load button
    loadBtn.addEventListener('click', async () => {
        const url = customUrlInput.value.trim();
        
        if (!url) {
            showStatus('error', 'Please enter a storage URL');
            return;
        }
        
        // Validate URL format
        try {
            new URL(url);
        } catch {
            showStatus('error', 'Invalid URL format');
            return;
        }
        
        // Disable button during load
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
        showStatus('loading', 'Connecting to storage...');
        
        try {
            const result = await loadDataFromCustomUrl(url);
            saveCustomUrl(url);
            BlobExplorerAnalytics.customUrlLoad(url, result.count);
            showStatus('success', `Loaded ${result.count.toLocaleString()} items successfully!`);
            
            // Close modal after brief delay
            setTimeout(() => {
                closeSettingsModal();
            }, 1500);
            
        } catch (error) {
            showStatus('error', `Error: ${error.message}`);
        } finally {
            loadBtn.disabled = false;
            loadBtn.textContent = 'Open';
        }
    });
    
    // Handle reset button
    resetBtn.addEventListener('click', async () => {
        customUrlInput.value = '';
        saveCustomUrl('');
        hideStatus();
        
        // Clear cache and reload from server
        try {
            const db = await initDB();
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            store.delete('allDownloads');
            
            showStatus('loading', 'Resetting to default storage...');
            closeSettingsModal();
            
            // Navigate to home before reload (current path/search is irrelevant for new storage)
            window.location.hash = '';
            window.location.reload();
            
        } catch (error) {
            console.error('Failed to clear cache:', error);
            window.location.hash = '';
            window.location.reload();
        }
    });
    
    // Handle Enter key in input
    customUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            loadBtn.click();
        }
    });
    
    return { settingsModal, closeSettingsModal };
}

// ============================================================================
// Main Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const searchBar = searchInput.closest('.search-box');
    
    // Helper to toggle clear button visibility
    function updateClearButtonVisibility() {
        searchBar.classList.toggle('has-text', searchInput.value.length > 0);
    }
    
    // Apply custom logo from config
    if (typeof window.APP_CONFIG !== 'undefined' && window.APP_CONFIG.logoUrl) {
        const siteLogo = document.getElementById('siteLogo');
        if (siteLogo) {
            siteLogo.src = window.APP_CONFIG.logoUrl;
        }
    }

    // Explorer chrome: view mode, details pane, commands, sort headers
    initExplorerChrome();

    // Initialize all UI components
    initializeTheme();
    initializeSearch(updateClearButtonVisibility);
    initializeSortSelect();
    initializeVirtualScroll();
    initializeFilterDropdown();
    initializeBackToTop();
    initializeCopyHandlers();
    
    const { closeSidebar } = initializeSidebar();
    const { helpModal, closeHelpModal } = initializeHelpModal();
    initializePinModal();
    const { closeSettingsModal } = initializeSettingsModal();
    
    initializeKeyboardShortcuts(searchInput, helpModal, closeHelpModal, closeSidebar, closeSettingsModal, updateClearButtonVisibility);
    initializeUrlState(searchInput, updateClearButtonVisibility);
    
    // Check if we should load from custom URL
    const customUrl = getCustomUrl();
    if (isCustomUrlEnabled() && customUrl) {
        loadDataFromCustomUrl(customUrl).catch(error => {
            console.error('Failed to load custom URL, falling back to default:', error);
            saveCustomUrl(''); // Clear invalid URL
            loadData();
        });
    } else {
        loadData();
    }
});

// Test seam: `node --test tests/` loads this file as CommonJS to exercise
// pure helpers (see tests/app.test.mjs). Browsers never define `module`,
// so this guard never runs in production; app.js stays a plain <script>
// with no build step.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        esc,
        getFileExtension,
        formatFileSize,
        wildcardToRegex,
        fuzzyScore,
        makeSearchMatcher
    };
}
