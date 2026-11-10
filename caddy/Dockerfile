# Caddy mit Cloudflare-DNS (TLS ohne Port 80 am Edge) und Ratelimit (NEW_DESIGN.md 3.2, 12.3).
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
