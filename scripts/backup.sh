#!/usr/bin/env bash
# MTJ ERP — nightly SQLite snapshot backup.
# VACUUM INTO runs inside the mtj-erp container against the live DB (WAL-safe,
# atomic single-file snapshot). Snapshot lands in the bind-mounted data dir,
# gets gzipped to ~/erp-mtj-backups, is gzip-integrity-checked, then rotated.
# Keep: 14 daily copies. Override with KEEP env.
set -euo pipefail

DATA_DIR="$HOME/erp-mtj/data"
DEST_DIR="${DEST_DIR:-$HOME/erp-mtj-backups}"
KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP="$DATA_DIR/backup-snapshot.db"
OUT="$DEST_DIR/mtj_erp-$STAMP.db.gz"

mkdir -p "$DEST_DIR"
rm -f "$TMP"

podman exec mtj-erp node -e '
const { DatabaseSync } = require("node:sqlite");
const dir = process.env.MTJ_DATA_DIR || "/app/data";
const db = new DatabaseSync(dir + "/mtj_erp.db", { readOnly: true });
db.exec("VACUUM INTO \x27" + dir + "/backup-snapshot.db\x27");
db.close();
'

[ -s "$TMP" ] || { echo "[backup] FAIL: no snapshot produced" >&2; exit 1; }

gzip -c "$TMP" > "$OUT"
rm -f "$TMP"
gunzip -t "$OUT"   # integrity check of the artifact itself

# rotation: keep the newest $KEEP copies
ls -1t "$DEST_DIR"/mtj_erp-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f --

echo "[backup] OK $(du -h "$OUT" | cut -f1) -> $OUT"
