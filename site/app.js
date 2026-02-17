// App State
let allDownloads = [];
let filteredDownloads = [];
let currentPath = [];
let activeFileTypes = new Set(['Installer', 'PDF', 'ISO', 'ZIP']); // Default selections
let currentPage = 1;
const itemsPerPage = 100;
let worker = null;
let sortBy = 'date-desc'; // date-desc, date-asc, size-desc, size-asc, name-asc

// Performance optimizations
let folderTree = new Map(); // Hierarchical folder structure for O(1) navigation
let fileTypeCache = new Map(); // Cache file type info to avoid repeated calculations

// ============================================================================
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

// Accessibility helper - make list item with arrow key navigation
function makeListItemAccessible(element, clickHandler) {
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            clickHandler(e);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = element.nextElementSibling;
            if (next && next.getAttribute('tabindex') === '0') {
                next.focus();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = element.previousElementSibling;
            if (prev && prev.getAttribute('tabindex') === '0') {
                prev.focus();
            }
        }
    });
    element.addEventListener('click', clickHandler);
}

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
                    lastUpdatedEl.textContent = `Last updated ${relativeTime}`;
                    lastUpdatedEl.title = new Date(metadata.lastUpdated).toLocaleString();
                }
            }
            return metadata;
        }
    } catch (error) {
        console.log('Could not fetch metadata:', error);
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
    const loadingEl = document.getElementById('downloadList');
    
    try {
        // Fetch metadata first to check if server data is newer than cache
        loadingEl.innerHTML = '<div class="loading">Checking for updates...</div>';
        console.log('Fetching metadata...');
        const metadata = await fetchMetadata(true);
        const serverLastUpdated = metadata && metadata.lastUpdated ? new Date(metadata.lastUpdated).getTime() : null;
        
        // Try to load from cache, but only if it matches the server's last update
        console.log('Checking cache...');
        const cached = await getCachedData();
        if (cached && cached.downloads && cached.downloads.length > 0) {
            const cacheIsStale = serverLastUpdated && (!cached.serverLastUpdated || cached.serverLastUpdated < serverLastUpdated);
            
            if (!cacheIsStale) {
                console.log('Loading from cache:', cached.downloads.length, 'items (cache is current)');
                loadingEl.innerHTML = '<div class="loading">Loading from cache...</div>';
                allDownloads = cached.downloads;
                filteredDownloads = [...allDownloads];
                
                // Build optimized data structures
                console.log('Building folder tree and caching file types...');
                buildFolderTree();
                console.log('Folder tree built with', folderTree.size, 'nodes');
                
                initializeFilters();
                renderFavorites();
                displayDownloads();
                return;
            }
            
            console.log('Cache is stale (server updated at', new Date(serverLastUpdated).toISOString(), '), refreshing...');
        } else {
            console.log('No cache found');
        }
        
        console.log('Fetching JSON...');
        loadingEl.innerHTML = '<div class="loading">Downloading data (36MB)... This will take 10-20 seconds.</div>';
        
        // Load directly - more reliable than Web Worker
        const response = await fetch('data/downloads.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        console.log('Fetched, reading text...');
        loadingEl.innerHTML = '<div class="loading">Processing data... Please wait.</div>';
        
        const text = await response.text();
        console.log('Text loaded, size:', (text.length / 1024 / 1024).toFixed(2), 'MB');
        
        loadingEl.innerHTML = '<div class="loading">Parsing JSON... Almost done.</div>';
        
        const downloads = JSON.parse(text);
        console.log('Parsed successfully:', downloads.length, 'items');
        
        allDownloads = downloads;
        filteredDownloads = [...allDownloads];
        
        // Build optimized data structures
        console.log('Building folder tree and caching file types...');
        buildFolderTree();
        console.log('Folder tree built with', folderTree.size, 'nodes');
        
        // Cache the data with the server's lastUpdated timestamp for future freshness checks
        console.log('Caching data...');
        await cacheData({ downloads, timestamp: Date.now(), serverLastUpdated: serverLastUpdated || Date.now() });
        console.log('Data cached');
        
        console.log('Initializing UI...');
        initializeFilters();
        renderFavorites();
        displayDownloads();
        console.log('Done!');
        
    } catch (error) {
        console.error('Error loading downloads:', error);
        loadingEl.innerHTML = `<div class="no-results">Error loading downloads: ${error.message}<br>Please check the console for details.</div>`;
    }
}

// Build hierarchical folder tree for O(1) navigation
function buildFolderTree() {
    folderTree.clear();
    fileTypeCache.clear();
    
    // Initialize root
    folderTree.set('', { folders: new Set(), files: [] });
    
    allDownloads.forEach(download => {
        const parts = download.Name.split('/');
        const fileName = parts[parts.length - 1];
        
        // Pre-cache file type info
        getFileTypeInfo(download);
        
        // Add file to its parent folder
        const parentPath = parts.slice(0, -1).join('/');
        if (!folderTree.has(parentPath)) {
            folderTree.set(parentPath, { folders: new Set(), files: [] });
        }
        folderTree.get(parentPath).files.push(download);
        
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
    const contentType = download.ContentType || '';
    
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
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Create a download item DOM element
// @param {Object} download - The download object
// @param {boolean} showPath - Whether to show the folder path (used in search results)
// @returns {HTMLElement} The download item element
function createDownloadItemElement(download, showPath = false) {
    const typeInfo = getFileTypeInfo(download);
    const fileName = download.Name.split('/').pop();
    
    const itemEl = document.createElement('div');
    itemEl.className = 'download-item';
    itemEl.setAttribute('role', 'listitem');
    itemEl.setAttribute('tabindex', '0');
    
    // Add arrow key navigation
    itemEl.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = itemEl.nextElementSibling;
            if (next) next.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = itemEl.previousElementSibling;
            if (prev) prev.focus();
        }
    });
    
    let pathHtml = '';
    if (showPath) {
        const folderPath = download.Name.split('/').slice(0, -1).join(' / ');
        pathHtml = `<div class="download-path"><span class="icon-folder" aria-hidden="true"></span> ${folderPath || 'Root'}</div>`;
    }
    
    itemEl.innerHTML = `
        <div class="download-item-header">
            <div class="download-icon" aria-hidden="true">${typeInfo.icon}</div>
            <div class="download-info">
                <div class="download-name">${fileName}</div>
                ${pathHtml}
                <div class="download-meta">
                    <span class="meta-item"><span class="icon-${showPath ? 'file' : 'folder'}-small" aria-hidden="true"></span> <span class="sr-only">Type: </span>${typeInfo.name}</span>
                    <span class="meta-item"><span class="icon-size" aria-hidden="true"></span> <span class="sr-only">Size: </span>${formatFileSize(download.Length)}</span>
                    <span class="meta-item"><span class="icon-date" aria-hidden="true"></span> <span class="sr-only">Date: </span>${formatDate(download.LastModified)}</span>
                </div>
            </div>
        </div>
        <div class="download-item-footer">
            <div class="download-actions">
                <button class="copy-link-button" data-url="${download.Url}" data-path="${download.Name}" aria-label="Copy download link for ${fileName}"><span class="icon-copy" aria-hidden="true"></span> Copy Link</button>
                <button class="download-button" data-path="${download.Name}" data-url="${download.Url}" aria-label="Download ${fileName}">Download</button>
            </div>
        </div>
    `;
    
    return itemEl;
}

// Filter downloads based on criteria
// @param {Array} downloads - Array of download objects to filter
// @param {Object} options - Filter options
// @param {string} options.searchTerm - Search term (supports wildcards and regex)
// @param {Set} options.fileTypes - Set of file type names to include (empty = all)
// @param {boolean} options.excludeZeroByte - Whether to exclude 0-byte files (default: true)
// @returns {Array} Filtered downloads
function filterDownloads(downloads, options = {}) {
    const {
        searchTerm = '',
        fileTypes = new Set(),
        excludeZeroByte = true
    } = options;
    
    return downloads.filter(download => {
        // Exclude 0-byte files
        if (excludeZeroByte && download.Length <= 0) {
            return false;
        }
        
        // File type filter
        if (fileTypes.size > 0) {
            const typeInfo = getFileTypeInfo(download);
            if (!fileTypes.has(typeInfo.name)) {
                return false;
            }
        }
        
        // Search filter
        if (searchTerm) {
            const fullPath = download.Name.toLowerCase();
            if (!matchesSearch(fullPath, searchTerm.toLowerCase())) {
                return false;
            }
        }
        
        return true;
    });
}

// Initialize file type filters
function initializeFilters() {
    updateFileTypeFilterCounts();
}

// Update file type filter counts based on current search/filters
function updateFileTypeFilterCounts() {
    const searchTerm = document.getElementById('searchInput').value;
    
    // Get files that match current search criteria (but not file type filter)
    const matchingFiles = filterDownloads(allDownloads, {
        searchTerm,
        excludeZeroByte: true
        // Note: fileTypes not passed - we want counts for all types
    });
    
    // Count file types in matching files
    const fileTypeCounts = {};
    matchingFiles.forEach(download => {
        const typeInfo = getFileTypeInfo(download);
        fileTypeCounts[typeInfo.name] = (fileTypeCounts[typeInfo.name] || 0) + 1;
    });
    
    const filterContainer = document.getElementById('fileTypeFilter');
    const filterBtn = document.getElementById('filterBtnText');
    const currentSelections = new Set(activeFileTypes);
    filterContainer.innerHTML = '';
    
    const sortedTypes = Object.entries(fileTypeCounts).sort((a, b) => b[1] - a[1]);
    
    // Add Select All / Select None buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'dropdown-buttons';
    
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'dropdown-action-btn';
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sortedTypes.forEach(([type]) => activeFileTypes.add(type));
        updateFileTypeFilterCounts();
        currentPage = 1;
        displayDownloads();
        BlobExplorerAnalytics.filterChange(Array.from(activeFileTypes), sortedTypes.length);
    });
    
    const selectNoneBtn = document.createElement('button');
    selectNoneBtn.type = 'button';
    selectNoneBtn.className = 'dropdown-action-btn';
    selectNoneBtn.textContent = 'Select None';
    selectNoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeFileTypes.clear();
        updateFileTypeFilterCounts();
        currentPage = 1;
        displayDownloads();
        BlobExplorerAnalytics.filterChange([], sortedTypes.length);
    });
    
    buttonContainer.appendChild(selectAllBtn);
    buttonContainer.appendChild(selectNoneBtn);
    filterContainer.appendChild(buttonContainer);
    
    sortedTypes.forEach(([type, count]) => {
        const label = document.createElement('label');
        label.className = 'dropdown-checkbox';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = type;
        checkbox.checked = currentSelections.has(type) || activeFileTypes.has(type);
        
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                activeFileTypes.add(type);
            } else {
                activeFileTypes.delete(type);
            }
            updateFilterButtonText();
            currentPage = 1;
            displayDownloads();
            BlobExplorerAnalytics.filterChange(Array.from(activeFileTypes), sortedTypes.length);
        });
        
        const text = document.createElement('span');
        text.textContent = `${type} (${count})`;
        
        label.appendChild(checkbox);
        label.appendChild(text);
        filterContainer.appendChild(label);
    });
    
    updateFilterButtonText();
}



// Update filter button text
function updateFilterButtonText() {
    const filterBtn = document.getElementById('filterBtnText');
    const count = activeFileTypes.size;
    
    if (count === 0) {
        filterBtn.textContent = 'All Types';
    } else {
        const types = Array.from(activeFileTypes).join(', ');
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
                const folderName = matchedPart.split('/').pop();
                
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
    favoritesConfig.forEach((favorite, index) => {
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
            
            searchEl.innerHTML = `<span class="icon-search" aria-hidden="true"></span> ${favorite.displayName || favorite.label || 'Search'}`;
            makeKeyboardAccessible(searchEl, () => {
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = searchQuery;
                    const searchBar = searchInput.closest('.search-bar');
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
            
            folderEl.innerHTML = `<span class="icon-folder" aria-hidden="true"></span> ${folderName}`;
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
                    
                    folderEl.innerHTML = `<span class="icon-star" aria-hidden="true"></span> ${folderName}`;
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
    labelEl.textContent = 'My Views';
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
            <span class="user-favorite-name" tabindex="0" role="button"><span class="${iconClass}" aria-hidden="true"></span> ${fav.name}</span>
            <button class="user-favorite-edit" data-id="${fav.id}" title="Edit" aria-label="Edit ${fav.name}"><span class="icon-edit" aria-hidden="true"></span></button>
        `;
        
        // Click to navigate (with keyboard support)
        const nameEl = itemEl.querySelector('.user-favorite-name');
        const navigateHandler = () => {
            if (fav.type === 'search') {
                const searchInput = document.getElementById('searchInput');
                searchInput.value = fav.query;
                const searchBar = searchInput.closest('.search-bar');
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
    addPinEl.innerHTML = '<span class="icon-pin-add" aria-hidden="true"></span> Pin current view...';
    makeKeyboardAccessible(addPinEl, () => {
        const searchInput = document.getElementById('searchInput');
        const searchQuery = searchInput ? searchInput.value.trim() : '';
        
        if (searchQuery) {
            // Save current search
            openPinModal('add', { type: 'search', query: searchQuery, name: searchQuery });
        } else if (currentPath.length > 0) {
            // Save current folder
            const folderName = currentPath[currentPath.length - 1];
            openPinModal('add', { type: 'folder', path: [...currentPath], name: folderName });
        } else {
            showToast('Navigate to a folder or search first');
        }
    });
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
        titleEl.textContent = 'Pin to Favorites';
        deleteBtn.style.display = 'none';
    } else {
        titleEl.textContent = 'Edit Pin';
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
        showToast('Pinned to favorites!');
    } else {
        const id = parseInt(modal.dataset.editId, 10);
        updateUserFavorite(id, { name });
        showToast('Pin updated!');
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

// Build folder structure
function buildFolderStructure() {
    const structure = {};
    
    allDownloads.forEach(download => {
        const parts = download.Name.split('/');
        let current = structure;
        
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!current[part]) {
                current[part] = { _files: [], _folders: {} };
            }
            current = current[part]._folders;
        }
        
        const parentPath = parts.slice(0, -1).join('/');
        let parent = structure;
        for (const part of parts.slice(0, -1)) {
            parent = parent[part]._folders;
        }
        if (!parent._files) parent._files = [];
        parent._files.push(download);
    });
    
    return structure;
}

// Navigate to path
function navigateToPath(path) {
    currentPath = path;
    currentPage = 1; // Reset to first page when navigating
    
    // Track folder navigation
    const folderPath = path.join('/');
    const folderName = path.length > 0 ? path[path.length - 1] : 'Home';
    BlobExplorerAnalytics.folderNavigate(folderPath, folderName);
    
    // Clear search when navigating to a folder
    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchInput.value) {
        searchInput.value = '';
        const searchBar = searchInput.closest('.search-bar');
        if (searchBar) searchBar.classList.remove('has-text');
    }
    
    // Update browser history
    const url = new URL(window.location);
    url.searchParams.delete('q'); // Clear search query
    if (path.length > 0) {
        const pathString = path.join('/');
        url.searchParams.set('path', pathString);
    } else {
        // Remove path parameter for root/home
        url.searchParams.delete('path');
    }
    window.history.pushState({ path: path, search: '' }, '', url);
    
    renderFavorites();
    applyFilters();
    renderBreadcrumbs();
}

// Render breadcrumbs
function renderBreadcrumbs() {
    const breadcrumbsEl = document.getElementById('breadcrumbs');
    const searchTerm = document.getElementById('searchInput').value.trim();
    
    // If searching, show "Search results" instead of path
    if (searchTerm) {
        breadcrumbsEl.innerHTML = '<span class="breadcrumb search-breadcrumb">Search results</span>';
        return;
    }
    
    if (currentPath.length === 0) {
        breadcrumbsEl.innerHTML = '';
        return;
    }
    
    const crumbs = ['Home', ...currentPath];
    breadcrumbsEl.innerHTML = crumbs.map((crumb, index) => {
        const path = index === 0 ? [] : currentPath.slice(0, index);
        return `<span class="breadcrumb" tabindex="0" role="link" data-path='${JSON.stringify(path)}'>${crumb}</span>`;
    }).join('');
    
    breadcrumbsEl.querySelectorAll('.breadcrumb').forEach(el => {
        const navigateHandler = () => {
            const path = JSON.parse(el.dataset.path);
            navigateToPath(path);
        };
        el.addEventListener('click', navigateHandler);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigateHandler();
            }
        });
    });
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
    
    filteredDownloads = allDownloads.filter(download => {
        // Path filter
        if (currentPath.length > 0) {
            const pathPrefix = currentPath.join('/');
            if (!download.Name.startsWith(pathPrefix)) {
                return false;
            }
            // Only show direct children
            const remainder = download.Name.slice(pathPrefix.length + 1);
            const slashCount = (remainder.match(/\//g) || []).length;
            if (slashCount > 0) {
                return false;
            }
        } else {
            // At root, only show first-level items
            const slashCount = (download.Name.match(/\//g) || []).length;
            if (slashCount > 0) {
                return false;
            }
        }
        
        // File type filter
        if (activeFileTypes.size > 0) {
            const typeInfo = getFileTypeInfo(download);
            if (!activeFileTypes.has(typeInfo.name)) {
                return false;
            }
        }
        
        // Search filter - search in full path
        if (searchTerm) {
            const fullPath = download.Name.toLowerCase();
            
            if (!matchesSearch(fullPath, searchTerm)) {
                return false;
            }
        }
        
        return true;
    });
    
    currentPage = 1; // Reset to first page
    updateFileTypeFilterCounts(); // Update dropdown counts
    displayDownloads();
}

// Sort files based on current sort option
function sortFiles(files) {
    const sorted = [...files];
    
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
        case 'name-asc':
            sorted.sort((a, b) => {
                const nameA = a.Name.split('/').pop().toLowerCase();
                const nameB = b.Name.split('/').pop().toLowerCase();
                return nameA.localeCompare(nameB);
            });
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

// Check if search term matches (with wildcard and regex support)
function matchesSearch(text, searchTerm) {
    // Regex search: patterns starting with / or ^ are treated as regex
    const isRegex = searchTerm.startsWith('/') || searchTerm.startsWith('^');
    
    if (isRegex) {
        try {
            // Remove leading / if present (^ should be kept as it's part of the regex)
            const regexPattern = searchTerm.startsWith('/') ? searchTerm.slice(1) : searchTerm;
            const regex = new RegExp(regexPattern, 'i');
            return regex.test(text);
        } catch (e) {
            // Invalid regex, fall back to literal search
            return text.includes(searchTerm);
        }
    }
    
    const hasWildcard = searchTerm.includes('*') || searchTerm.includes('?');
    
    if (hasWildcard) {
        const regex = wildcardToRegex(searchTerm);
        return regex.test(text);
    } else {
        // Regular search with space-insensitive matching
        const textNoSpaces = text.replace(/\s/g, '');
        const searchTermNoSpaces = searchTerm.replace(/\s/g, '');
        return text.includes(searchTerm) || textNoSpaces.includes(searchTermNoSpaces);
    }
}

// Render search results
function renderSearchResults(filteredFiles, searchTerm) {
    const listEl = document.getElementById('downloadList');
    const resultCount = document.getElementById('resultCount');
    
    // Sort the files
    const sortedFiles = sortFiles(filteredFiles);
    
    const totalItems = sortedFiles.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    
    updatePagination(totalItems, totalPages);
    
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, totalItems);
    const pageItems = sortedFiles.slice(startIdx, endIdx);
    
    resultCount.textContent = `${totalItems} matching file${totalItems !== 1 ? 's' : ''} (showing ${startIdx + 1}-${endIdx})`;
    
    if (totalItems === 0) {
        listEl.innerHTML = '<div class="no-results">No files found matching "' + searchTerm + '"</div>';
        document.getElementById('paginationTop').style.display = 'none';
        document.getElementById('paginationBottom').style.display = 'none';
        return;
    }
    
    const fragment = document.createDocumentFragment();
    
    pageItems.forEach(download => {
        const itemEl = createDownloadItemElement(download, true);
        fragment.appendChild(itemEl);
    });
    
    listEl.innerHTML = '';
    listEl.appendChild(fragment);
    
    document.querySelector('.content').scrollTop = 0;
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
            if (activeFileTypes.size > 0) {
                const typeInfo = getFileTypeInfo(download);
                return activeFileTypes.has(typeInfo.name);
            }
            return true; // No filter, any non-zero file counts
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

// Display downloads with pagination
function displayDownloads() {
    const listEl = document.getElementById('downloadList');
    const resultCount = document.getElementById('resultCount');
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    
    // Update breadcrumbs to reflect search state
    renderBreadcrumbs();
    
    // If searching, show all matching files from anywhere
    if (searchTerm) {
        const filteredFiles = filterDownloads(allDownloads, {
            searchTerm,
            fileTypes: activeFileTypes,
            excludeZeroByte: true
        });
        
        renderSearchResults(filteredFiles, searchTerm);
        return;
    }
    
    // Use tree structure for O(1) folder navigation
    const pathKey = currentPath.join('/');
    const node = folderTree.get(pathKey);
    
    if (!node) {
        listEl.innerHTML = '<div class="no-results">Folder not found</div>';
        return;
    }
    
    const folders = Array.from(node.folders);
    
    // Filter files using shared utility
    const files = filterDownloads(node.files, {
        fileTypes: activeFileTypes,
        excludeZeroByte: true
    });
    
    // Filter folders that contain matching files (recursive check)
    // Always filter to hide empty folders (no non-zero files)
    const filteredFolders = folders.filter(folderName => folderHasMatchingFiles(pathKey, folderName));
    
    // Sort files
    const sortedFiles = sortFiles(files);
    
    const allItems = [...filteredFolders.sort().map(f => ({ type: 'folder', name: f })),
                      ...sortedFiles.map(f => ({ type: 'file', data: f }))];
    
    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    
    // Update pagination
    updatePagination(totalItems, totalPages);
    
    // Calculate pagination
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, totalItems);
    const pageItems = allItems.slice(startIdx, endIdx);
    
    resultCount.textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''} (showing ${startIdx + 1}-${endIdx})`;
    
    if (totalItems === 0) {
        listEl.innerHTML = '<div class="no-results">No downloads found matching your criteria.</div>';
        document.getElementById('paginationTop').style.display = 'none';
        document.getElementById('paginationBottom').style.display = 'none';
        return;
    }
    
    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Render items
    pageItems.forEach(item => {
        if (item.type === 'folder') {
            const folderEl = document.createElement('div');
            folderEl.className = 'download-item folder-item-display';
            folderEl.setAttribute('role', 'listitem');
            folderEl.innerHTML = `
                <span class="folder-icon" aria-hidden="true"><span class="icon-folder"></span></span>
                <div class="download-info">
                    <div class="download-name">${item.name}</div>
                </div>
            `;
            makeListItemAccessible(folderEl, () => {
                navigateToPath([...currentPath, item.name]);
            });
            fragment.appendChild(folderEl);
        } else {
            const itemEl = createDownloadItemElement(item.data, false);
            fragment.appendChild(itemEl);
        }
    });
    
    listEl.innerHTML = '';
    listEl.appendChild(fragment);
    
    // Scroll to top
    document.querySelector('.content').scrollTop = 0;
}

// Update pagination controls
function updatePagination(totalItems, totalPages) {
    const paginationTop = document.getElementById('paginationTop');
    const paginationBottom = document.getElementById('paginationBottom');
    
    if (totalPages <= 1) {
        paginationTop.style.display = 'none';
        paginationBottom.style.display = 'none';
        return;
    }
    
    paginationTop.style.display = 'flex';
    paginationBottom.style.display = 'flex';
    
    // Update both pagination controls
    [paginationTop, paginationBottom].forEach((pagination, idx) => {
        const pageInfo = pagination.querySelector('span');
        const firstBtn = pagination.querySelector('button:nth-child(1)');
        const prevBtn = pagination.querySelector('button:nth-child(2)');
        const nextBtn = pagination.querySelector('button:nth-child(4)');
        const lastBtn = pagination.querySelector('button:nth-child(5)');
        
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
        
        firstBtn.disabled = currentPage === 1;
        prevBtn.disabled = currentPage === 1;
        nextBtn.disabled = currentPage === totalPages;
        lastBtn.disabled = currentPage === totalPages;
    });
}

// Get total items for current view (used by pagination)
function getCurrentViewItemCount() {
    const searchTerm = document.getElementById('searchInput').value;
    
    if (searchTerm) {
        // During search, count all matching files
        return filterDownloads(allDownloads, {
            searchTerm,
            fileTypes: activeFileTypes,
            excludeZeroByte: true
        }).length;
    }
    
    // Folder view - count folders + files
    const pathKey = currentPath.join('/');
    const node = folderTree.get(pathKey);
    if (!node) return 0;
    
    const folders = Array.from(node.folders);
    const files = filterDownloads(node.files, {
        fileTypes: activeFileTypes,
        excludeZeroByte: true
    });
    
    const filteredFolders = folders.filter(folderName => folderHasMatchingFiles(pathKey, folderName));
    return filteredFolders.length + files.length;
}

// Navigate pages
function goToPage(page) {
    currentPage = page;
    displayDownloads();
}

function nextPage() {
    const totalItems = getCurrentViewItemCount();
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (currentPage < totalPages) {
        currentPage++;
        displayDownloads();
    }
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        displayDownloads();
    }
}

function firstPage() {
    currentPage = 1;
    displayDownloads();
}

function lastPage() {
    const totalItems = getCurrentViewItemCount();
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    currentPage = totalPages;
    displayDownloads();
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

// Copy text to clipboard with button feedback
async function copyToClipboard(text, button, originalText, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        button.innerHTML = '✓ Copied!';
        button.classList.add('copied');
        if (successMessage) showToast(successMessage);
        
        setTimeout(() => {
            button.innerHTML = originalText;
            button.classList.remove('copied');
        }, 2000);
    } catch (err) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        
        try {
            document.execCommand('copy');
            button.innerHTML = '✓ Copied!';
            button.classList.add('copied');
            if (successMessage) showToast(successMessage);
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.classList.remove('copied');
            }, 2000);
        } catch (e) {
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

// Initialize pagination controls
function initializePagination() {
    const paginationButtons = [
        { id: 'firstPage', handler: firstPage },
        { id: 'prevPage', handler: prevPage },
        { id: 'nextPage', handler: nextPage },
        { id: 'lastPage', handler: lastPage },
        { id: 'firstPageBottom', handler: firstPage },
        { id: 'prevPageBottom', handler: prevPage },
        { id: 'nextPageBottom', handler: nextPage },
        { id: 'lastPageBottom', handler: lastPage }
    ];
    
    paginationButtons.forEach(({ id, handler }) => {
        document.getElementById(id).addEventListener('click', handler);
    });
    
    // Sort dropdown
    document.getElementById('sortBy').addEventListener('change', (e) => {
        sortBy = e.target.value;
        displayDownloads();
    });
}

// Initialize file type filter dropdown
function initializeFilterDropdown() {
    const filterDropdownBtn = document.getElementById('fileTypeFilterBtn');
    const filterDropdown = document.getElementById('fileTypeFilter');
    
    filterDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = filterDropdown.classList.toggle('show');
        filterDropdownBtn.setAttribute('aria-expanded', isOpen);
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-dropdown')) {
            filterDropdown.classList.remove('show');
            filterDropdownBtn.setAttribute('aria-expanded', 'false');
        }
    });
    
    // Prevent dropdown from closing when clicking inside
    filterDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
}

// Initialize mobile sidebar
function initializeSidebar() {
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    
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
        if (e.target.closest('.folder-item') || e.target.closest('.favorite-item') || e.target.closest('#homeLink')) {
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
    const content = document.querySelector('.content');
    
    function checkScrollPosition() {
        const scrollTop = content ? content.scrollTop : window.scrollY;
        backToTopBtn.classList.toggle('visible', scrollTop > 300);
    }
    
    if (content) {
        content.addEventListener('scroll', checkScrollPosition);
    }
    window.addEventListener('scroll', checkScrollPosition);
    
    backToTopBtn.addEventListener('click', () => {
        if (content) {
            content.scrollTo({ top: 0, behavior: 'smooth' });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
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

// Initialize keyboard shortcuts
function initializeKeyboardShortcuts(searchInput, helpModal, closeHelpModal, closeSidebar, updateClearButtonVisibility) {
    const sidebar = document.getElementById('sidebar');
    const pinModal = document.getElementById('pinModal');
    
    document.addEventListener('keydown', (e) => {
        const isInputFocused = document.activeElement.tagName === 'INPUT' || 
                               document.activeElement.tagName === 'TEXTAREA';
        
        // "/" - Focus search
        if (e.key === '/' && !isInputFocused) {
            e.preventDefault();
            searchInput.focus();
        }
        
        // Escape - Clear search or close sidebar/modal
        if (e.key === 'Escape') {
            if (pinModal.classList.contains('active')) {
                closePinModal();
            } else if (helpModal.classList.contains('active')) {
                closeHelpModal();
            } else if (sidebar.classList.contains('active')) {
                closeSidebar();
            } else if (searchInput.value && !isInputFocused) {
                searchInput.value = '';
                updateClearButtonVisibility();
                applyFilters();
                searchInput.blur();
            } else if (isInputFocused) {
                document.activeElement.blur();
            }
        }
    });
}

// Initialize copy button handlers (event delegation)
function initializeCopyHandlers() {
    // Link copy button handler
    document.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.copy-link-button');
        if (copyBtn) {
            e.preventDefault();
            e.stopPropagation();
            const filePath = copyBtn.dataset.path;
            const fileName = filePath ? filePath.split('/').pop() : '';
            if (filePath) {
                BlobExplorerAnalytics.copyLink(fileName, filePath);
            }
            copyToClipboard(copyBtn.dataset.url, copyBtn, '<span class="icon-copy"></span> Copy Link', 'Link copied to clipboard!');
        }
    });
    
    // Download button handler (event delegation)
    document.addEventListener('click', (e) => {
        const downloadBtn = e.target.closest('.download-button');
        if (downloadBtn) {
            e.preventDefault();
            const url = downloadBtn.dataset.url;
            const filePath = downloadBtn.dataset.path;
            if (url && filePath) {
                // Track the download
                const fileName = filePath.split('/').pop();
                const download = allDownloads.find(d => d.Name === filePath);
                const fileSize = download ? download.Length : 0;
                const typeInfo = download ? getFileTypeInfo(download) : { name: 'Unknown' };
                BlobExplorerAnalytics.download(fileName, filePath, fileSize, typeInfo.name);
                window.open(url, '_blank');
            }
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
    const loadingEl = document.getElementById('downloadList');
    
    try {
        loadingEl.innerHTML = '<div class="loading">Connecting to storage...</div>';
        
        const blobs = await fetchBlobsFromUrl(customUrl, (status) => {
            loadingEl.innerHTML = `<div class="loading">${status}</div>`;
        });
        
        console.log('Fetched', blobs.length, 'blobs from custom URL');
        
        if (blobs.length === 0) {
            throw new Error('No blobs found in storage container');
        }
        
        // Clear existing data
        allDownloads = blobs;
        filteredDownloads = [...allDownloads];
        
        // Rebuild optimized data structures
        console.log('Building folder tree...');
        buildFolderTree();
        console.log('Folder tree built with', folderTree.size, 'nodes');
        
        // Cache the data
        await cacheData({ downloads: blobs, timestamp: Date.now(), customUrl: customUrl });
        
        // Reset to home and re-render
        currentPath = [];
        initializeFilters();
        renderFavorites();
        displayDownloads();
        
        // Update last updated display
        const lastUpdatedEl = document.getElementById('lastUpdated');
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = 'Custom storage loaded just now';
            lastUpdatedEl.title = new Date().toLocaleString();
        }
        
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
        settingsStatus.style.display = 'flex';
        settingsStatus.className = 'settings-status ' + type;
        settingsStatus.querySelector('.status-text').textContent = message;
    };
    
    const hideStatus = () => {
        settingsStatus.style.display = 'none';
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
            loadBtn.textContent = 'Load Storage';
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
    const searchBar = searchInput.closest('.search-bar');
    
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

    // Initialize all UI components
    initializeTheme();
    initializeSearch(updateClearButtonVisibility);
    initializePagination();
    initializeFilterDropdown();
    initializeBackToTop();
    initializeCopyHandlers();
    
    const { closeSidebar } = initializeSidebar();
    const { helpModal, closeHelpModal } = initializeHelpModal();
    initializePinModal();
    initializeSettingsModal();
    
    initializeKeyboardShortcuts(searchInput, helpModal, closeHelpModal, closeSidebar, updateClearButtonVisibility);
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
