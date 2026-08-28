# MTJ Channel Manager — Migration Guide

The ERP ships as an OCI container image. Everything stateful lives in ONE bind-mounted
folder, so migrating servers = copy one directory + one command.

## Layout on this host
- App: `/home/mtj/erp-mtj` (Containerfile, code, ui/)
- State: `/home/mtj/erp-mtj/data/mtj_erp.db` (SQLite, WAL mode) — **the only thing that matters**
- Runs via: `mtj-erp.service` (systemd user service wrapping podman)
- Reachable at: https://erp.ptmtj.com (Cloudflare tunnel `lisa-tunnel.service`, ingress → 127.0.0.1:9121)

## Migrate to a new server
```bash
# 1. On the OLD server — stop cleanly and pack
systemctl --user stop mtj-erp
tar czf mtj-erp-migration.tar.gz -C /home/mtj erp-mtj
# copy the tarball to the new server (scp/rsync/USB)

# 2. On the NEW server — needs podman + cloudflared + your tunnel credentials json
tar xzf mtj-erp-migration.tar.gz -C /home/mtj
cd /home/mtj/erp-mtj
podman build -t mtj-erp .

# 3a. Run ad-hoc (bind to loopback like here; put your reverse proxy/tunnel in front)
mkdir -p data && chown 1000:1000 data   # volume must be writable by uid 1000 (node user in image)
podman run -d --name mtj-erp \
  -p 127.0.0.1:9121:9121 \
  -v /home/mtj/erp-mtj/data:/app/data:Z \
  --restart=always mtj-erp

# 3b. Or systemd-managed (recommended): bring along mtj-erp.service from
#     ~/.config/systemd/user/, then:
systemctl --user daemon-reload && systemctl --user enable --now mtj-erp
loginctl enable-linger $USER

# 4. Point DNS/tunnel: same Cloudflare tunnel config (hostname erp.ptmtj.com -> http://127.0.0.1:9121)
```

## Update the app after code changes
```bash
cd /home/mtj/erp-mtj
podman build -t mtj-erp . && systemctl --user restart mtj-erp
```

## Backup (do this regularly — it's one file)
```bash
cp /home/mtj/erp-mtj/data/mtj_erp.db /backup/path/mtj_erp_$(date +%F).db   # while running is OK-ish (WAL),
# but the safe way:
systemctl --user stop mtj-erp && cp data/mtj_erp.db /backup/ && systemctl --user start mtj-erp
```

## Notes
- Auth stays INSIDE the app (Basic Auth via MTJ_USER/MTJ_PASS env vars) — no dependency on host nginx etc.
- Image runs as non-root user `node`; keep the mounted data dir owned by uid 1000.
- The cloudflared tunnel itself does NOT need to be containerized — it just points at port 9121.
