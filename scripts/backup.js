'use strict';
// Резервна копія бази: node scripts/backup.js  (або npm run backup)
// Кладе копію в BACKUP_DIR (за замовчуванням <DATA_DIR>/backups) і лишає останні 30 штук.
const fs = require('fs');
const path = require('path');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { open } = require('../src/sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dest = path.join(BACKUP_DIR, `teamcars-${stamp}.db`);

(async () => {
  const db = open(path.join(DATA_DIR, 'teamcars.db'));
  await db.backup(dest);
  db.close();
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^teamcars-.*\.db$/.test(f)).sort();
  files.slice(0, Math.max(0, files.length - 30)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  console.log('Backup:', dest);
})().catch(e => { console.error(e); process.exit(1); });
