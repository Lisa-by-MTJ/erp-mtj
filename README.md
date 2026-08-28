# erp-mtj

MTJ Channel Manager ERP for PT Monalisa Tunggal Jaya.

- Stack: Node.js (no deps), SQLite (server data/), rootless Podman
- Deploy: Containerfile + systemd user unit (mtj-erp.service), port 9121
- Migration: see MIGRATE.md
- Auto commit+push: erp-mtj-autopush.service (this repo)

Managed by Lisa (Hermes Agent) for Lisa-by-MTJ.
