FROM nginx:alpine@sha256:1d13701a5f9f3fb01aaa88cef2344d65b6b5bf6b7d9fa4cf0dca557a8d7702ba

# OCI labels for local builds; overridden by docker/metadata-action in CI
LABEL org.opencontainers.image.title="Blob Explorer" \
      org.opencontainers.image.description="A self-hosted web interface for browsing and downloading files from any public Azure Blob Storage container" \
      org.opencontainers.image.url="https://github.com/joshooaj/blobexplorer" \
      org.opencontainers.image.source="https://github.com/joshooaj/blobexplorer" \
      org.opencontainers.image.documentation="https://github.com/joshooaj/blobexplorer#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="joshooaj"

RUN apk add --no-cache \
    python3 \
    gzip \
    tzdata \
    tini \
    && mkdir -p /usr/share/nginx/html/data /scripts /config-defaults

# Copy files in order of change frequency (least → most) for better layer caching
# nginx config rarely changes
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Default config files rarely change
COPY config/ /config-defaults/

# Scripts change occasionally
COPY --chmod=755 scripts/ /scripts/

# Static site files change most frequently
COPY site/ /usr/share/nginx/html/

# Environment variables for configuration
ENV BASE_URL="" \
    DOWNLOAD_BASE="" \
    SITE_TITLE="Blob Explorer" \
    SITE_DESCRIPTION="Browse and download files from Azure Blob Storage" \
    LOGO_URL="" \
    LOGO_FILE="" \
    UPDATE_INTERVAL=86400 \
    ALLOW_CUSTOM_URL=false \
    TZ=UTC

EXPOSE 8080

HEALTHCHECK --start-period=10s --start-interval=2s --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO /dev/null http://localhost:8080/ || exit 1

# Use tini as init system to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/scripts/entrypoint.sh"]
