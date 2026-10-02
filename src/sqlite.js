'use strict';
// Тонкий адаптер над SQLite.
// На сервері використовується better-sqlite3 (як у проєкті «Мясо з Техасу»).
// Якщо його не встановлено, а Node >= 22.13, працює вбудований node:sqlite — зручно для локальних тестів.
// Логіка застосунку бачить однаковий інтерфейс: prepare().run/get/all, exec, transaction(fn).

function open(file) {
  let Better = null;
  try { Better = require('better-sqlite3'); } catch (e) { /* fallback below */ }

  if (Better) {
    const db = new Better(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return {
      driver: 'better-sqlite3',
      prepare: sql => db.prepare(sql),
      exec: sql => db.exec(sql),
      transaction: fn => db.transaction(fn),
      backup: dest => db.backup(dest),
      close: () => db.close(),
    };
  }

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) {
    throw new Error('Не знайдено драйвер SQLite. Виконайте `npm install` (better-sqlite3) або використайте Node 22.13+.');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cache = new Map();
  const prepare = sql => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  let depth = 0;
  return {
    driver: 'node:sqlite',
    prepare,
    exec: sql => db.exec(sql),
    transaction: fn => (...args) => {
      if (depth > 0) return fn(...args);
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(...args); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
      finally { depth--; }
    },
    backup: async dest => { db.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`); },
    close: () => db.close(),
  };
}

module.exports = { open };
