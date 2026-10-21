// Dev-only lint config. Runs on site/*.js (browser globals) and tests/*.mjs
// (node globals). Nothing here ships in the image; the Dockerfile only
// copies site/, config/, scripts/, and nginx.conf.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        files: ['site/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            // `module` is only read by the test-seam guard at the bottom of app.js
            globals: { ...globals.browser, module: 'readonly' }
        }
    },
    {
        files: ['tests/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: globals.node
        }
    }
];
