#!/bin/sh
# Generate runtime configuration from config file + environment variables
# ENV vars take precedence over config file values

CONFIG_FILE="/config/config.json"
OUTPUT_FILE="/usr/share/nginx/html/config.js"

# Read values from config file using Python (available in the container)
read_config() {
    python3 << PYTHON_SCRIPT
import json
import os
import sys

config_file = "$CONFIG_FILE"
config = {}

# Dockerfile default values - if ENV equals these, treat as "not set"
DOCKERFILE_DEFAULTS = {
    'SITE_TITLE': 'Blob Explorer',
    'SITE_DESCRIPTION': 'Browse and download files from Azure Blob Storage',
    'LOGO_URL': '',
    'LOGO_FILE': ''
}

def get_env_override(env_var):
    """Get ENV var only if it's set to something other than Dockerfile default."""
    value = os.environ.get(env_var, '')
    default = DOCKERFILE_DEFAULTS.get(env_var, '')
    # If ENV matches Dockerfile default, treat as not explicitly set
    if value == default:
        return None
    return value or None

# Load config file if it exists
if os.path.exists(config_file):
    try:
        with open(config_file) as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in config file '{config_file}': {e}", file=os.sys.stderr)
        print("Please fix the config file and restart the container.", file=os.sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Could not read config file '{config_file}': {e}", file=os.sys.stderr)
        sys.exit(1)

# Get values: ENV override takes precedence, then config file, then default
site_title = get_env_override('SITE_TITLE') or config.get('siteTitle') or 'Blob Explorer'
site_description = get_env_override('SITE_DESCRIPTION') or config.get('siteDescription') or 'Browse and download files from Azure Blob Storage'
logo_url = get_env_override('LOGO_URL') or config.get('logoUrl') or ''
logo_file = get_env_override('LOGO_FILE') or config.get('logoFile') or ''
download_base = os.environ.get('DOWNLOAD_BASE') or os.environ.get('BASE_URL', '')
allow_custom_url = os.environ.get('ALLOW_CUSTOM_URL', 'false').lower() == 'true'
analytics_script = config.get('analyticsScript') or ''

# Get favorites from config (no ENV override for this complex structure)
favorites = config.get('favorites', [])

# Filter out entries with _comment (example entries)
favorites = [f for f in favorites if '_comment' not in f]

# Handle logoFile: if set, resolve to a served URL path
if logo_file:
    logo_src = os.path.join('/config', logo_file)
    if os.path.isfile(logo_src):
        import shutil
        logo_dest = os.path.join('/usr/share/nginx/html/assets', 'custom-logo' + os.path.splitext(logo_file)[1])
        shutil.copy2(logo_src, logo_dest)
        logo_url = 'assets/custom-logo' + os.path.splitext(logo_file)[1]
    else:
        print(f"Warning: logoFile not found: {logo_src}", file=os.sys.stderr)

# Generate JavaScript config
js_config = f'''// Runtime configuration - generated at container startup
window.APP_CONFIG = {{
    siteTitle: {json.dumps(site_title)},
    siteDescription: {json.dumps(site_description)},
    logoUrl: {json.dumps(logo_url)},
    logoFile: {json.dumps(logo_file)},
    downloadBase: {json.dumps(download_base)},
    allowCustomUrl: {str(allow_custom_url).lower()},
    favorites: {json.dumps(favorites, indent=8)}
}};
'''

print(js_config)

# Also output values for shell script to use
print(f"__SITE_TITLE__={site_title}", file=os.sys.stderr)
print(f"__SITE_DESCRIPTION__={site_description}", file=os.sys.stderr)
print(f"__ANALYTICS_SCRIPT__={analytics_script}", file=os.sys.stderr)
PYTHON_SCRIPT
}

# Generate the config.js file
CONFIG_OUTPUT=$(read_config 2>&1)
CONFIG_EXIT=$?

if [ $CONFIG_EXIT -ne 0 ]; then
    echo "$CONFIG_OUTPUT" >&2
    exit $CONFIG_EXIT
fi

# Extract the JavaScript part (stdout) and metadata (stderr)
echo "$CONFIG_OUTPUT" | grep -v "^__" > "$OUTPUT_FILE"

# Extract values for updating index.html
EFFECTIVE_SITE_TITLE=$(echo "$CONFIG_OUTPUT" | grep "^__SITE_TITLE__=" | cut -d= -f2-)
EFFECTIVE_SITE_DESCRIPTION=$(echo "$CONFIG_OUTPUT" | grep "^__SITE_DESCRIPTION__=" | cut -d= -f2-)
EFFECTIVE_ANALYTICS_SCRIPT=$(echo "$CONFIG_OUTPUT" | grep "^__ANALYTICS_SCRIPT__=" | cut -d= -f2-)

echo "Generated config.js with SITE_TITLE=${EFFECTIVE_SITE_TITLE:-Blob Explorer}"

# Update index.html with the effective title
if [ -n "$EFFECTIVE_SITE_TITLE" ] && [ "$EFFECTIVE_SITE_TITLE" != "Blob Explorer" ]; then
    sed -i "s|<title>Blob Explorer</title>|<title>${EFFECTIVE_SITE_TITLE}</title>|g" /usr/share/nginx/html/index.html
fi

# Update meta description
if [ -n "$EFFECTIVE_SITE_DESCRIPTION" ] && [ "$EFFECTIVE_SITE_DESCRIPTION" != "Browse and download files from Azure Blob Storage" ]; then
    sed -i "s|content=\"Browse and download files from Azure Blob Storage\"|content=\"${EFFECTIVE_SITE_DESCRIPTION}\"|g" /usr/share/nginx/html/index.html
fi

# Inject analytics script if file path is provided
if [ -n "$EFFECTIVE_ANALYTICS_SCRIPT" ]; then
    ANALYTICS_FILE="/config/${EFFECTIVE_ANALYTICS_SCRIPT}"
    if [ -f "$ANALYTICS_FILE" ]; then
        echo "Injecting custom analytics from: $ANALYTICS_FILE"
        # Read the analytics file and inject before </head>
        python3 << INJECT_SCRIPT
import os

analytics_file = '$ANALYTICS_FILE'

# Read the analytics script file
with open(analytics_file, 'r') as f:
    analytics_content = f.read().strip()

# Wrap in script tags if not already wrapped
if not analytics_content.startswith('<script') and not analytics_content.startswith('<!--'):
    analytics_content = f'<script>\n{analytics_content}\n</script>'

with open('/usr/share/nginx/html/index.html', 'r') as f:
    html_content = f.read()

# Inject before </head>
html_content = html_content.replace('</head>', f'{analytics_content}\n</head>')

with open('/usr/share/nginx/html/index.html', 'w') as f:
    f.write(html_content)
INJECT_SCRIPT
    else
        echo "Warning: Analytics script file not found: $ANALYTICS_FILE"
    fi
fi
