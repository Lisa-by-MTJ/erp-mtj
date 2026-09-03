#!/usr/bin/env node
// Standalone Google Drive stock sync script for MTJ ERP
// Downloads warehouse stock spreadsheets from Google Drive and prints a summary.
// This script is NOT part of the main ERP server — run independently.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_PATH = path.join(process.env.HOME || '/home/mtj', '.hermes', 'google_token.json');

// Files to sync from Google Drive
const TARGET_FILES = [
  { name: '1. Alvinity Warehouse Stock.xls', folder: '03. Business Development' },
  { name: '3. Monalisa Warehouse Stock 2026.xlsx', folder: null },
];

async function loadGoogleApis() {
  try {
    const { google } = require('googleapis');
    return google;
  } catch (e) {
    console.error('╔══════════════════════════════════════════════════════════╗');
    console.error('║  googleapis package not installed.                      ║');
    console.error('║  Run: npm install googleapis                           ║');
    console.error('║  (This is a standalone script, not part of main ERP)    ║');
    console.error('╚══════════════════════════════════════════════════════════╝');
    process.exit(1);
  }
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error(`Google token not found at ${TOKEN_PATH}`);
    console.error('Please authenticate with Google first (OAuth2 flow).');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  return raw;
}

async function findFileByName(drive, fileName, folderId) {
  let query = `name='${fileName.replace(/'/g, "\\'")}' and trashed=false`;
  if (folderId) query += ` and '${folderId}' in parents`;
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, size, modifiedTime, mimeType)',
    spaces: 'drive',
  });
  return (res.data.files || [])[0] || null;
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get({ fileId, altMedia: true }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

async function main() {
  console.log('=== MTJ ERP — Google Drive Stock Sync ===');
  console.log(`Token path: ${TOKEN_PATH}`);
  console.log('');

  const google = await loadGoogleApis();
  const token = loadToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expiry_date: token.expiry_date,
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // Resolve the folder ID for '03. Business Development' if needed
  const folderQuery = "name='03. Business Development' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const folderRes = await drive.files.list({ q: folderQuery, fields: 'files(id, name)', spaces: 'drive' });
  const targetFolder = (folderRes.data.files || [])[0];
  if (!targetFolder) {
    console.error('Could not find folder "03. Business Development" on Google Drive.');
    process.exit(1);
  }
  console.log(`Found folder: ${targetFolder.name} (id: ${targetFolder.id})`);
  console.log('');

  for (const file of TARGET_FILES) {
    console.log(`--- Searching for: ${file.name} ---`);
    const folderId = file.folder ? targetFolder.id : null;
    const found = await findFileByName(drive, file.name, folderId);
    if (!found) {
      console.log(`  ⚠ File not found: ${file.name}`);
      continue;
    }
    console.log(`  Found: ${found.name}`);
    console.log(`  ID: ${found.id}`);
    console.log(`  Size: ${found.size ? (Number(found.size) / 1024).toFixed(1) + ' KB' : 'N/A'}`);
    console.log(`  Modified: ${found.modifiedTime}`);
    console.log(`  MIME: ${found.mimeType}`);

    // Download to temp file
    const ext = path.extname(file.name) || '.xlsx';
    const tmpPath = path.join(__dirname, `tmp_${Date.now()}${ext}`);
    try {
      await downloadFile(drive, found.id, tmpPath);
      console.log(`  Downloaded to: ${tmpPath}`);

      // Try to parse with xlsx if available
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(tmpPath);
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          console.log(`  Sheet "${sheetName}": ${data.length} rows`);
          if (data.length > 0) {
            console.log(`    Headers: ${JSON.stringify(data[0])}`);
          }
        }
      } catch (e) {
        console.log(`  (xlsx parser not available — file downloaded but not parsed)`);
        console.log(`  To enable parsing: npm install xlsx`);
      }
    } catch (e) {
      console.error(`  ✗ Download failed: ${e.message}`);
    }
    console.log('');
  }

  // Cleanup temp files
  const tmpFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('tmp_'));
  for (const f of tmpFiles) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }

  console.log('=== Sync summary complete. No data was written to the database. ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
