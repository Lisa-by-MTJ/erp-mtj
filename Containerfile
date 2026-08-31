# MTJ Channel Manager — OCI image (Blueprint V2.0)
# Build:  podman build -t mtj-erp .
# Run:    podman run -d --name mtj-erp -p 127.0.0.1:9121:9121 \
#           -v mtj-erp-data:/app/data:Z --restart=always mtj-erp
FROM docker.io/library/node:24-alpine

# tini-style init to reap signals properly; app itself needs nothing else (zero deps)
ENV NODE_ENV=production
WORKDIR /app

# dependency-free: only copy what the runtime needs
COPY package.json server.js db.js approval.js posting.js dashboard.js dashboard_ext.js api.js web.js ./
COPY ui ./ui

# data dir is expected as a volume so the SQLite DB survives container replacement
# NOTE: run as container-root on purpose. Under ROOTLESS podman, container root maps to
# the host user's uid, which owns the bind-mounted data dir. A non-root container user
# would map to an unrelated subuid and lose write access ("readonly database").
RUN mkdir -p /app/data

EXPOSE 9121
ENV MTJ_BIND=0.0.0.0 MTJ_PORT=9121 MTJ_DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9121/').then(r=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", "/app/server.js"]
