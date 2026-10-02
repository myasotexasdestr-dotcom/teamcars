'use strict';
// Аварийный сброс PIN (если забыли PIN единственного админа).
// Запуск на сервере:  node scripts/reset-pin.js "Богдан Анатолійович" 4821
// Пользователь станет активным админом с новым PIN. Сервер можно не останавливать.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { openDatabase, loadSecret } = require('../src/db');

const [name, pin] = process.argv.slice(2);
if (!name || !/^\d{4,8}$/.test(pin || '')) { console.error('Использование: node scripts/reset-pin.js "Имя пользователя" 1234   (PIN — 4–8 цифр)'); process.exit(1); }
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = openDatabase(DATA_DIR);
const hash = crypto.createHmac('sha256', loadSecret(DATA_DIR)).update('pin:' + pin).digest('hex');
const u = db.prepare('SELECT * FROM users WHERE name = ? AND deleted = 0').get(name);
if (!u) { console.error('Пользователь не найден. Есть:', db.prepare('SELECT name FROM users WHERE deleted = 0').all().map(r => r.name).join(', ')); process.exit(1); }
const clash = db.prepare('SELECT name FROM users WHERE pin_hash = ? AND active = 1 AND deleted = 0 AND id != ?').get(hash, u.id);
if (clash) { console.error(`Этот PIN уже у «${clash.name}». Выберите другой.`); process.exit(1); }
db.prepare("UPDATE users SET pin_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(hash, u.id);
db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'").run();
db.close();
console.log(`Готово: «${u.name}» — активный админ с новым PIN.`);
