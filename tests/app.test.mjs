import test from 'node:test';
import assert from 'node:assert/strict';

// app.js runs in a browser. The only statements it executes at load time
// are localStorage reads, window.matchMedia, window.BlobExplorerAnalytics,
// and a DOMContentLoaded registration, so these stubs cover the import.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, dispatchEvent: () => false };

const app = (await import('../site/app.js')).default;
const { esc, getFileExtension, formatFileSize, wildcardToRegex, fuzzyScore, makeSearchMatcher } = app;

test('esc neutralizes HTML metacharacters from untrusted blob names', () => {
    assert.equal(esc(`<script src="a&b'c">`), '&lt;script src=&quot;a&amp;b&#39;c&quot;&gt;');
    assert.equal(esc('plain'), 'plain');
});

test('getFileExtension lowercases, strips query strings, handles edge cases', () => {
    assert.equal(getFileExtension('dir/file.TAR.GZ?restype=1'), 'gz');
    assert.equal(getFileExtension('a/b#frag.zip'), 'zip');
    assert.equal(getFileExtension('archive'), 'unknown');
    assert.equal(getFileExtension('folder/file.'), 'unknown');
});

test('formatFileSize formats byte counts', () => {
    assert.equal(formatFileSize(0), '0 Bytes');
    assert.equal(formatFileSize(1024), '1 KB');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatFileSize(5 * 1024 ** 4), '5 TB');
    assert.equal(formatFileSize(20 * 1024 ** 4), '20 TB'); // caps at TB
});

test('wildcardToRegex supports * and ?, escapes regex metacharacters', () => {
    assert.ok(wildcardToRegex('v*').test('v1.2'));
    assert.ok(wildcardToRegex('v*').test('Version 2')); // case-insensitive
    assert.ok(wildcardToRegex('a?c').test('abc'));
    assert.ok(!wildcardToRegex('a?c').test('ac'));
    assert.ok(!wildcardToRegex('a.b').test('axb'));
    assert.ok(wildcardToRegex('a.b').test('A.B'));
});

test('fuzzyScore returns -1 for non-subsequences and rewards contiguity', () => {
    assert.equal(fuzzyScore('xyz', 'protect'), -1);
    assert.ok(fuzzyScore('pro', 'protect') > 0);
    assert.ok(fuzzyScore('prot', 'protect') > fuzzyScore('prt', 'protect'));
    assert.equal(fuzzyScore('', 'anything'), 0);
});

test('makeSearchMatcher: plain term is a case-sensitive substring', () => {
    const m = makeSearchMatcher('readme');
    assert.ok(m('readme.txt'));
    assert.ok(!m('README.TXT'));
});

test('makeSearchMatcher: spaces are ignored', () => {
    assert.ok(makeSearchMatcher('read me')('readme.txt'));
});

test('makeSearchMatcher: * and ? use wildcard regex', () => {
    assert.ok(makeSearchMatcher('file*.txt')('file_2024.txt'));
    assert.ok(!makeSearchMatcher('file*.txt')('file_2024.pdf'));
});

test('makeSearchMatcher: leading / or ^ is a case-insensitive regex', () => {
    assert.ok(makeSearchMatcher('/\\.pdf$')('Report.PDF'));
    assert.ok(!makeSearchMatcher('/\\.pdf$')('report.pdfx'));
    assert.ok(makeSearchMatcher('^XProtect \\d{4}')('XProtect 2024 R2/setup.exe'));
});

test('makeSearchMatcher: invalid regex falls back to literal', () => {
    assert.ok(makeSearchMatcher('^(')('log^(entry'));
});

test('makeSearchMatcher: ~ is fuzzy, ~~ escapes a literal tilde', () => {
    assert.ok(makeSearchMatcher('~prot')('my protect file'));
    assert.ok(!makeSearchMatcher('~xyz')('my protect file'));
    assert.ok(makeSearchMatcher('~~fix')('tilde ~fix mode'));
    assert.ok(!makeSearchMatcher('~~fix')('tilde fix mode'));
});
