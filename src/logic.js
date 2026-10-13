'use strict';
// Уся бізнес-логіка. Кожна дія виконується в одній транзакції SQLite:
// або змінюється все (угода + залишки + журнал + гроші), або нічого.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACCOUNTS, PRICE_CURRENCY } = require('./db');

// Групи запчастин (як у каталогах розборок); підкатегорії — вільний текст у межах групи
const GROUPS = ['doors', 'engine', 'interior', 'wheels', 'body', 'fluids', 'suspension', 'brakes', 'transmission', 'electrics'];
const STATES = { new: ['new', 0, 0], analog: ['new', 1, 0], used: ['used', 0, 0], defect: ['used', 0, 1] };
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

class AppError extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; }
}
const fail = (msg, status, code) => { throw new AppError(msg, status, code); };

const ACC = Object.fromEntries(ACCOUNTS.map(a => [a.id, a]));
const nowISO = () => new Date().toISOString();
const newId = p => p + crypto.randomBytes(6).toString('hex');
const round2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(6, '0');

function num(v, label, { min = 0, allowZero = true } = {}) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) fail(`${label}: вкажіть число`);
  if (n < min || (!allowZero && n === 0)) fail(`${label}: має бути ${allowZero ? 'не менше ' + min : 'більше 0'}`);
  return round2(n);
}
function int(v, label, min = 0, max = 100000) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) fail(`${label}: має бути цілим числом від ${min}`);
  if (n > max) fail(`${label}: не більше ${max}`);
  return n;
}
function str(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

function createLogic(db, secret) {
  const q = sql => db.prepare(sql);

  // ---------- PIN ----------
  // PIN зберігається як HMAC-SHA256 із серверним секретом (data/.secret), не відкритим текстом.
  // Детермінований хеш дозволяє перевіряти унікальність PIN серед активних користувачів.
  const pinHash = pin => crypto.createHmac('sha256', secret).update('pin:' + pin).digest('hex');
  const validPin = pin => /^\d{4,8}$/.test(String(pin));

  // ---------- meta / version ----------
  const getMeta = k => q('SELECT value FROM meta WHERE key = ?').get(k)?.value;
  const setMeta = (k, v) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  const version = () => Number(getMeta('version'));
  const bump = () => setMeta('version', version() + 1);

  // ---------- lookups ----------
  const getUser = id => q('SELECT * FROM users WHERE id = ?').get(id);
  const getWh = id => q('SELECT * FROM warehouses WHERE id = ?').get(id);
  const getProduct = id => q('SELECT * FROM products WHERE id = ?').get(id);
  const getDeal = id => q('SELECT * FROM deals WHERE id = ?').get(id);
  const defaultWhRow = () => q('SELECT * FROM warehouses WHERE is_default = 1 AND active = 1 AND deleted = 0').get() || q('SELECT * FROM warehouses WHERE active = 1 AND deleted = 0 ORDER BY created_at').get();
  const getDonor = id => q('SELECT * FROM donors WHERE id = ? AND deleted = 0').get(id);
  function insertProduct(id, cols, fields) {
    const art = Number(getMeta('next_art') || 1); setMeta('next_art', art + 1);
    const at = nowISO();
    q(`INSERT INTO products (id, ${cols}, art, active, created_at, updated_at) VALUES (?, ${cols.split(', ').map(() => '?').join(', ')}, ?, 1, ?, ?)`).run(id, ...fields, art, at, at);
  }
  const dealItems = id => q('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY position, id').all(id);
  const qty = (p, w) => q('SELECT quantity FROM inventory WHERE product_id = ? AND warehouse_id = ?').get(p, w)?.quantity || 0;
  // Баланс каси фірми; інвестиції ведуться окремо й сюди не входять
  const balance = acc => round2(q("SELECT COALESCE(SUM(amount), 0) AS s FROM financial_transactions WHERE account_id = ? AND type NOT IN ('investment','repayment')").get(acc).s);
  const activeAdmins = except => q('SELECT COUNT(*) AS c FROM users WHERE active = 1 AND deleted = 0 AND role = ? AND id != ?').get('admin', except || '').c;
  const whQty = wid => q('SELECT COALESCE(SUM(i.quantity),0) AS s FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.warehouse_id = ? AND p.active = 1').get(wid).s;
  const openDealsOnWh = wid => q("SELECT DISTINCT d.no FROM deals d JOIN deal_items i ON i.deal_id = d.id WHERE d.status = 'new' AND i.warehouse_id = ? ORDER BY d.no").all(wid).map(r => r.no);

  // ---------- journals ----------
  function changeInv(productId, warehouseId, change, type, userId, dealId = null, at = nowISO()) {
    const before = qty(productId, warehouseId);
    const after = before + change;
    if (after < 0) {
      const p = getProduct(productId), w = getWh(warehouseId);
      fail(`«${p ? p.name : productId}»: на ${w ? w.name : 'складі'} лише ${before} шт.`, 409, 'stock');
    }
    q(`INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?, ?, ?)
       ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = excluded.quantity`).run(productId, warehouseId, after);
    q(`INSERT INTO inventory_transactions (id, product_id, warehouse_id, change, before_qty, after_qty, type, deal_id, user_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId('it_'), productId, warehouseId, change, before, after, type, dealId, userId, at);
  }
  function addFin(f) {
    q(`INSERT INTO financial_transactions (id, account_id, amount, currency, type, deal_id, deal_amount_uah, deal_currency, rate, user_id, at, taken_by, taken_by_user_id, purpose, recorded_at, investor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newId('ft_'), f.accountId, round2(f.amount), ACC[f.accountId].currency, f.type, f.dealId || null,
      f.dealAmountUah ?? null, f.dealCurrency || null, f.rate ?? null, f.userId, f.at || nowISO(), f.takenBy || null, f.takenByUserId || null, f.purpose || null, nowISO(), f.investorUserId || null);
  }

  // ---------- validation helpers ----------
  function needAccount(id) { if (!ACC[id]) fail('Невідомий рахунок'); return ACC[id]; }
  function needActiveWh(id) { const w = getWh(id); if (!w || !w.active || w.deleted) fail('Склад не знайдено або деактивовано'); return w; }
  function keyMap(items) {
    const m = new Map();
    items.forEach(i => { const k = i.productId + '|' + i.warehouseId; m.set(k, (m.get(k) || 0) + i.quantity); });
    return m;
  }
  function cleanItems(raw, orig = new Map()) {
    if (!Array.isArray(raw) || raw.length === 0) fail('Додайте хоча б одну запчастину');
    if (raw.length > 200) fail('Забагато позицій');
    const items = raw.map((r, idx) => {
      const p = getProduct(str(r.productId, 64));
      const key = (p && p.id) + '|' + str(r.warehouseId, 64);
      if (!p || (!p.active && !orig.has(key))) fail(`Позиція ${idx + 1}: товар не знайдено`);
      const w = getWh(str(r.warehouseId, 64));
      if (!w || w.deleted || (!w.active && !orig.has(key))) fail(`«${p.name}»: склад недоступний`);
      return { productId: p.id, warehouseId: w.id, quantity: int(r.quantity, `«${p.name}», кількість`, 1), price: num(r.price, `«${p.name}», ціна`), name: p.name, whName: w.name };
    });
    for (const [k, need] of keyMap(items)) {
      const [pid, wid] = k.split('|');
      const avail = qty(pid, wid) + (orig.get(k) || 0);
      if (need > avail) { const it = items.find(i => i.productId === pid && i.warehouseId === wid); fail(`«${it.name}»: на ${it.whName} лише ${avail} шт.`, 409, 'stock'); }
    }
    return items;
  }
  // Курс: якщо угода в гривні — ₴ за одиницю валюти рахунку; інакше — валюта рахунку за 1 одиницю валюти угоди.
  function calcRate(accCur, dealCur, amount, total) {
    if (accCur === dealCur) return 1;
    const r = dealCur === 'UAH' ? total / amount : amount / total;
    return Math.round(r * 10000) / 10000;
  }
  // Скільки вже оплачено по угоді (у валюті угоди)
  const paidOf = dealId => round2(q("SELECT COALESCE(SUM(deal_amount_uah), 0) AS s FROM financial_transactions WHERE deal_id = ? AND type = 'sale'").get(dealId).s);
  // cover — яку частину суми угоди (у валюті угоди) покриває платіж. Без cover: у тій самій валюті — сама сума (не більше залишку), в іншій — увесь залишок.
  function payInfo(accountId, amountRaw, remaining, dealCur, coverRaw) {
    const a = needAccount(accountId);
    const amount = (amountRaw === '' || amountRaw == null) && a.currency === dealCur ? remaining : num(amountRaw, 'Сума зарахування', { allowZero: false });
    if (!(amount > 0)) fail('Сума зарахування має бути більше 0');
    let cover;
    if (coverRaw !== '' && coverRaw != null) {
      cover = num(coverRaw, 'Сума по угоді', { allowZero: false });
      if (cover > remaining + 0.005) fail(`По угоді залишилось сплатити лише ${remaining}`);
    } else cover = a.currency === dealCur ? Math.min(amount, remaining) : remaining;
    cover = round2(cover);
    return { account: a, amount, cover, rate: calcRate(a.currency, dealCur, amount, cover) };
  }
  function applyPayment(deal, info, user) {
    addFin({ accountId: info.account.id, amount: info.amount, type: 'sale', dealId: deal.id, dealAmountUah: info.cover, dealCurrency: deal.currency || 'UAH', rate: info.rate, userId: user.id });
    settleIfPaid(deal.id, info);
  }
  function settleIfPaid(dealId, info) {
    const d = getDeal(dealId);
    if (d.status !== 'new' || paidOf(d.id) < d.total - 0.005) return false;
    const last = info || (() => { const t = q("SELECT * FROM financial_transactions WHERE deal_id = ? AND type = 'sale' ORDER BY at DESC LIMIT 1").get(d.id); return t && { account: ACC[t.account_id], amount: t.amount, rate: t.rate }; })();
    q(`UPDATE deals SET payment_status = 'paid', status = 'done', paid_at = ?, pay_account = ?, pay_amount = ?, pay_currency = ?, pay_rate = ? WHERE id = ?`)
      .run(nowISO(), last ? last.account.id : null, last ? last.amount : null, last ? last.account.currency : null, last ? last.rate : null, d.id);
    return true;
  }
  // Повернення коштів з рахунку (з перевіркою залишку)
  function refundFin(accountId, amount, f) {
    if (!(amount > 0)) return;
    const bal = balance(accountId);
    if (amount > bal + 1e-9) fail(`На рахунку ${ACC[accountId].name} лише ${bal} — недостатньо для повернення ${amount}`, 409, 'balance');
    addFin({ ...f, accountId, amount: -amount, type: 'return' });
  }
  function insertItems(dealId, items) {
    const ins = q('INSERT INTO deal_items (deal_id, product_id, warehouse_id, quantity, price, position) VALUES (?, ?, ?, ?, ?, ?)');
    items.forEach((i, idx) => ins.run(dealId, i.productId, i.warehouseId, i.quantity, i.price, idx));
  }
  function dealHeader(p) {
    const customer = str(p.customer, 200); if (!customer) fail('Вкажіть ПІБ покупця');
    const delivery = p.delivery === 'delivery' ? 'delivery' : 'pickup';
    const details = delivery === 'delivery' ? str(p.details, 2000) : '';
    if (delivery === 'delivery' && !details) fail('Вкажіть дані для доставки');
    return { customer, delivery, details };
  }
  function whBlock(w) {
    if (w.is_default) return 'Спершу зробіть основним інший склад';
    const n = whQty(w.id); if (n > 0) return `На складі є товар (${n} шт.). Спершу перемістіть або обнуліть залишки.`;
    const od = openDealsOnWh(w.id); if (od.length) return `З цього складу відвантажують неоплачені угоди: ${od.map(n => '№' + pad(n)).join(', ')}. Спершу закрийте або змініть їх.`;
    return '';
  }
  // Борг фірми перед інвестором по конкретному рахунку = внесено − погашено
  const invested = (uid, acc) => round2(q("SELECT COALESCE(SUM(amount), 0) AS s FROM financial_transactions WHERE investor_user_id = ? AND account_id = ? AND type IN ('investment','repayment')").get(uid, acc).s);
  function investOp(user, p, sign) {
    const inv = getUser(str(p.investorId, 64)); if (!inv || inv.deleted) fail('Оберіть інвестора');
    const a = needAccount(p.accountId);
    const amount = num(p.amount, 'Сума', { allowZero: false });
    const at = new Date(p.at || Date.now()); if (isNaN(at)) fail('Невірна дата');
    if (sign < 0) {
      const owed = invested(inv.id, a.id);
      if (amount > owed + 1e-9) fail(`${inv.name}: по рахунку ${a.name} до погашення лише ${owed}`, 409, 'invest');
    }
    addFin({ accountId: a.id, amount: sign * amount, type: sign > 0 ? 'investment' : 'repayment', userId: user.id, at: at.toISOString(),
      takenBy: inv.name, takenByUserId: inv.id, investorUserId: inv.id, purpose: str(p.purpose, 1000) || null });
    return { amount, account: a.name, investor: inv.name };
  }
  const requireAdmin = user => { if (user.role !== 'admin') fail('Ця дія доступна лише адміну', 403, 'forbidden'); };

  // ---------- actions ----------
  const actions = {
    createDeal(user, p) {
      const h = dealHeader(p);
      const items = cleanItems(p.items);
      const total = round2(items.reduce((s, i) => s + i.quantity * i.price, 0));
      const no = Number(getMeta('next_deal_no')); setMeta('next_deal_no', no + 1);
      const id = 'd_' + no + '_' + crypto.randomBytes(3).toString('hex');
      q(`INSERT INTO deals (id, no, customer_name, delivery_type, delivery_details, total, currency, payment_status, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unpaid', 'new', ?, ?)`).run(id, no, h.customer, h.delivery, h.details, total, PRICE_CURRENCY, user.id, nowISO());
      insertItems(id, items);
      items.forEach(i => changeInv(i.productId, i.warehouseId, -i.quantity, 'sale', user.id, id));
      if (p.payment) applyPayment(getDeal(id), payInfo(p.payment.accountId, p.payment.amount, total, PRICE_CURRENCY, p.payment.cover), user);
      return { dealId: id, no };
    },
    updateDeal(user, p) {
      const d = getDeal(str(p.dealId, 64));
      if (!d || d.status !== 'new') fail('Змінювати можна лише неоплачену угоду', 409, 'state');
      const h = dealHeader(p);
      const orig = keyMap(dealItems(d.id).map(i => ({ productId: i.product_id, warehouseId: i.warehouse_id, quantity: i.quantity })));
      const items = cleanItems(p.items, orig);
      const next = keyMap(items);
      // спочатку повертаємо прибране, потім списуємо додане — щоб не впертися в нуль посередині
      const keys = new Set([...orig.keys(), ...next.keys()]);
      const diffs = [...keys].map(k => ({ k, diff: (next.get(k) || 0) - (orig.get(k) || 0) })).filter(x => x.diff);
      diffs.filter(x => x.diff < 0).forEach(({ k, diff }) => { const [pid, wid] = k.split('|'); changeInv(pid, wid, -diff, 'return', user.id, d.id); });
      diffs.filter(x => x.diff > 0).forEach(({ k, diff }) => { const [pid, wid] = k.split('|'); changeInv(pid, wid, -diff, 'sale', user.id, d.id); });
      q('DELETE FROM deal_items WHERE deal_id = ?').run(d.id);
      insertItems(d.id, items);
      const total = round2(items.reduce((s, i) => s + i.quantity * i.price, 0));
      const paid = paidOf(d.id);
      if (paid > total + 0.005) fail(`По угоді вже внесено ${paid} — сума угоди не може бути меншою`, 409, 'paid');
      q('UPDATE deals SET customer_name = ?, delivery_type = ?, delivery_details = ?, total = ?, edited_at = ?, edited_by = ? WHERE id = ?')
        .run(h.customer, h.delivery, h.details, total, nowISO(), user.id, d.id);
      if (paid > 0) settleIfPaid(d.id);
      return { dealId: d.id, no: d.no };
    },
    payDeal(user, p) {
      const d = getDeal(str(p.dealId, 64));
      if (!d || d.status !== 'new') fail('Угоду вже оплачено або видалено', 409, 'state');
      const remaining = round2(d.total - paidOf(d.id));
      if (remaining <= 0.005) { settleIfPaid(d.id); fail('Угоду вже повністю оплачено', 409, 'state'); }
      const info = payInfo(p.accountId, p.amount, remaining, d.currency || 'UAH', p.cover);
      applyPayment(d, info, user);
      return { dealId: d.id, amount: info.amount, currency: info.account.currency, account: info.account.name, done: getDeal(d.id).status === 'done' };
    },
    cancelDeal(user, p) {
      const d = getDeal(str(p.dealId, 64));
      if (!d || d.status !== 'new') fail('Видалити можна лише неоплачену угоду', 409, 'state');
      dealItems(d.id).forEach(i => changeInv(i.product_id, i.warehouse_id, i.quantity, 'return', user.id, d.id));
      // передоплату повертаємо на ті самі рахунки
      q("SELECT * FROM financial_transactions WHERE deal_id = ? AND type = 'sale'").all(d.id).forEach(t =>
        refundFin(t.account_id, t.amount, { dealId: d.id, dealAmountUah: -(t.deal_amount_uah || 0), dealCurrency: t.deal_currency, rate: t.rate, userId: user.id, purpose: 'Повернення передоплати' }));
      q("UPDATE deals SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(nowISO(), user.id, str(p.reason, 500), d.id);
      return { dealId: d.id, no: d.no };
    },
    addStock(user, p) {
      const pr = getProduct(str(p.productId, 64)); if (!pr || !pr.active) fail('Товар не знайдено');
      const w = needActiveWh(str(p.warehouseId, 64));
      const n = int(p.quantity, 'Кількість', 1);
      changeInv(pr.id, w.id, n, 'receipt', user.id);
      return { productId: pr.id };
    },
    saveProduct(user, p) {
      const name = str(p.name, 300); if (!name) fail('Вкажіть назву товару');
      const price = p.price === '' || p.price == null ? 0 : num(p.price, 'Ціна');
      const market = p.marketPrice === '' || p.marketPrice == null ? null : num(p.marketPrice, 'Ринкова ціна');
      const st = STATES[p.state] || [p.condition === 'new' ? 'new' : 'used', 0, p.defective ? 1 : 0];
      const photos = (Array.isArray(p.photos) ? p.photos : []).map(String).filter(u => /^\/photos\/[a-z0-9_-]+\.(jpg|png|webp)$/i.test(u)).slice(0, 20);
      const stock = p.stock && typeof p.stock === 'object' ? p.stock : {};
      const bn = p.block === '' || p.block == null ? null : Number(p.block);
      if (bn !== null && !(Number.isInteger(bn) && bn >= 1 && bn <= 20)) fail('Блок має бути від 1 до 20');
      const grp = GROUPS.includes(p.group) ? p.group : '';
      const sub = grp ? str(p.sub, 100) : '';
      let donorId = p.donorId ? str(p.donorId, 64) : null;
      if (donorId && !getDonor(donorId)) fail('Донора не знайдено');
      const compat = (Array.isArray(p.compat) ? p.compat : String(p.compat ?? '').split(/\r?\n/)).map(x => str(x, 120)).filter(Boolean).slice(0, 50).join('\n');
      const fields = [str(p.catalogNumber, 100).toUpperCase(), name, price, st[0], st[2], str(p.notes, 4000), bn, donorId, grp, sub, st[1], str(p.manufacturer, 100), market, compat];
      const cols = 'catalog_number, name, price, condition, defective, notes, block, donor_id, grp, sub, analog, manufacturer, market_price, compat';
      let id = p.id ? str(p.id, 64) : null;
      if (id) {
        const ex = getProduct(id); if (!ex || !ex.active) fail('Товар не знайдено');
        q(`UPDATE products SET ${cols.split(', ').map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...fields, nowISO(), id);
      } else {
        id = newId('p_');
        insertProduct(id, cols, fields);
      }
      q('DELETE FROM product_photos WHERE product_id = ?').run(id);
      photos.forEach((u, i) => q('INSERT INTO product_photos (product_id, url, position) VALUES (?, ?, ?)').run(id, u, i));
      for (const [wid, raw] of Object.entries(stock)) {
        const w = getWh(wid); if (!w || !w.active || w.deleted) continue;
        const target = int(raw, `Кількість на «${w.name}»`, 0);
        const diff = target - qty(id, wid);
        if (diff) changeInv(id, wid, diff, p.id ? 'adjustment' : 'receipt', user.id);
      }
      return { productId: id };
    },
    saveDonor(user, p) {
      const make = str(p.make, 60); if (!make) fail('Вкажіть марку авто');
      const cost = p.cost === '' || p.cost == null ? null : num(p.cost, 'Вартість донора');
      const f = [make, str(p.model, 60), str(p.years, 30), str(p.engine, 60), str(p.color, 40), str(p.vin, 30).toUpperCase(), str(p.notes, 2000), cost];
      let id = p.id ? str(p.id, 64) : null;
      if (id) {
        if (!getDonor(id)) fail('Донора не знайдено');
        q('UPDATE donors SET make = ?, model = ?, years = ?, engine = ?, color = ?, vin = ?, notes = ?, cost = ? WHERE id = ?').run(...f, id);
      } else {
        id = newId('dn_');
        q('INSERT INTO donors (id, make, model, years, engine, color, vin, notes, cost, deleted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(id, ...f, nowISO());
      }
      return { donorId: id };
    },
    // Повернення товару з оплаченої угоди (повністю або частково)
    returnDeal(user, p) {
      const d = getDeal(str(p.dealId, 64));
      if (!d || d.status !== 'done') fail('Повернення можливе лише для оплаченої угоди', 409, 'state');
      const raw = Array.isArray(p.items) ? p.items : [];
      const rows = dealItems(d.id);
      const back = q('SELECT product_id, warehouse_id, SUM(quantity) AS q FROM deal_returns WHERE deal_id = ? GROUP BY product_id, warehouse_id').all(d.id);
      const backMap = new Map(back.map(r => [r.product_id + '|' + r.warehouse_id, r.q]));
      const items = [];
      for (const r of raw) {
        const n = Number(r.quantity) || 0; if (!n) continue;
        const k = str(r.productId, 64) + '|' + str(r.warehouseId, 64);
        const lines = rows.filter(x => x.product_id + '|' + x.warehouse_id === k);
        if (!lines.length) fail('Цього товару немає в угоді');
        const sold = lines.reduce((s, x) => s + x.quantity, 0);
        const left = sold - (backMap.get(k) || 0) - items.filter(i => i.k === k).reduce((s, i) => s + i.n, 0);
        const qn = int(n, 'Кількість повернення', 1);
        if (qn > left) fail(`Повернути можна не більше ${left} шт. цієї позиції`);
        const price = lines.reduce((s, x) => s + x.quantity * x.price, 0) / sold;
        items.push({ k, n: qn, productId: lines[0].product_id, warehouseId: lines[0].warehouse_id, value: round2(qn * price) });
      }
      if (!items.length) fail('Оберіть, що повертається');
      const value = round2(items.reduce((s, i) => s + i.value, 0));
      let accountId = null, refund = 0;
      if (p.accountId) {
        const a = needAccount(p.accountId); accountId = a.id;
        refund = p.amount === '' || p.amount == null ? 0 : num(p.amount, 'Сума повернення');
      }
      const no = newId('rt_'), at = nowISO(), reason = str(p.reason, 500);
      if (refund > 0) refundFin(accountId, refund, { dealId: d.id, dealAmountUah: -value, dealCurrency: d.currency || 'UAH', rate: calcRate(ACC[accountId].currency, d.currency || 'UAH', refund, value), userId: user.id, purpose: 'Повернення товару' + (reason ? ': ' + reason : '') });
      for (const i of items) {
        const w = getWh(i.warehouseId);
        const wid = w && w.active && !w.deleted ? w.id : needActiveWh((defaultWhRow() || {}).id).id;
        changeInv(i.productId, wid, i.n, 'return', user.id, d.id);
        q('INSERT INTO deal_returns (id, deal_id, return_no, product_id, warehouse_id, quantity, value, account_id, refund, reason, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(newId('dr_'), d.id, no, i.productId, wid, i.n, i.value, accountId, items.indexOf(i) === 0 ? refund : 0, reason, user.id, at);
      }
      return { dealId: d.id, no: d.no, units: items.reduce((s, i) => s + i.n, 0), value, refund };
    },
    // Інвентаризація блоку: фактична кількість на складі, розбіжності — корекцією в журнал
    inventoryBlock(user, p) {
      const w = needActiveWh(str(p.warehouseId, 64));
      const bn = Number(p.block); if (!(Number.isInteger(bn) && bn >= 1 && bn <= 20)) fail('Оберіть блок від 1 до 20');
      const counts = Array.isArray(p.counts) ? p.counts : [];
      if (!counts.length) fail('Немає позицій для перевірки');
      if (counts.length > 500) fail('Забагато позицій');
      let diffs = 0, moved = 0;
      for (const c of counts) {
        const pr = getProduct(str(c.productId, 64)); if (!pr || !pr.active) continue;
        const target = int(c.quantity, `«${pr.name}», кількість`, 0);
        const diff = target - qty(pr.id, w.id);
        if (diff) { changeInv(pr.id, w.id, diff, 'adjustment', user.id); diffs++; }
        if (target > 0 && pr.block !== bn) { q('UPDATE products SET block = ?, updated_at = ? WHERE id = ?').run(bn, nowISO(), pr.id); moved++; }
      }
      setMeta(`inv:${w.id}:${bn}`, JSON.stringify({ at: nowISO(), by: user.id, diffs }));
      return { diffs, moved };
    },
    addProductPhotos(user, p) {
      const pr = getProduct(str(p.productId, 64)); if (!pr || !pr.active) fail('Товар не знайдено');
      const list = (Array.isArray(p.photos) ? p.photos : []).map(String).filter(u => /^\/photos\/[a-z0-9_-]+\.(jpg|png|webp)$/i.test(u));
      if (!list.length) fail('Немає фото');
      let pos = q('SELECT COALESCE(MAX(position), -1) AS m FROM product_photos WHERE product_id = ?').get(pr.id).m;
      const have = q('SELECT COUNT(*) AS c FROM product_photos WHERE product_id = ?').get(pr.id).c;
      list.slice(0, Math.max(0, 20 - have)).forEach(u => q('INSERT INTO product_photos (product_id, url, position) VALUES (?, ?, ?)').run(pr.id, u, ++pos));
      q('UPDATE products SET updated_at = ? WHERE id = ?').run(nowISO(), pr.id);
      return { productId: pr.id };
    },
    // Поставка запчастин з донора: прихід на склад + привʼязка до донора.
    // Якщо позиція каталогу вже привʼязана до іншого донора — створюється її копія для цього донора.
    donorSupply(user, p) {
      const d = getDonor(str(p.donorId, 64)); if (!d) fail('Донора не знайдено');
      const w = needActiveWh(str(p.warehouseId, 64));
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) fail('Додайте хоча б одну запчастину');
      if (items.length > 300) fail('Забагато позицій за раз');
      const copyCols = 'catalog_number, name, price, condition, defective, notes, block, donor_id, grp, sub, analog, manufacturer, market_price, compat, ex_url, ex_img';
      let units = 0; const ids = [];
      for (const it of items) {
        const pr = getProduct(str(it.productId, 64)); if (!pr || !pr.active) fail('Товар не знайдено');
        const n = int(it.quantity, `«${pr.name}», кількість`, 1);
        const price = it.price === '' || it.price == null ? null : num(it.price, `«${pr.name}», ціна`);
        let id = pr.id;
        if (pr.donor_id && pr.donor_id !== d.id && getDonor(pr.donor_id)) {
          id = newId('p_');
          insertProduct(id, copyCols, copyCols.split(', ').map(c => c === 'donor_id' ? d.id : c === 'price' ? (price ?? pr.price) : pr[c]));
          q('SELECT url, position FROM product_photos WHERE product_id = ? ORDER BY position, id').all(pr.id).forEach(r => q('INSERT INTO product_photos (product_id, url, position) VALUES (?, ?, ?)').run(id, r.url, r.position));
        } else {
          q('UPDATE products SET donor_id = ?, price = COALESCE(?, price), updated_at = ? WHERE id = ?').run(d.id, price && price > 0 ? price : null, nowISO(), id);
        }
        changeInv(id, w.id, n, 'receipt', user.id);
        units += n; ids.push(id);
      }
      return { donorId: d.id, units, positions: ids.length };
    },
    deleteDonor(user, p) {
      const d = getDonor(str(p.id, 64)); if (!d) fail('Донора не знайдено');
      q('UPDATE donors SET deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), user.id, d.id);
      q('UPDATE products SET donor_id = NULL WHERE donor_id = ?').run(d.id);
      return { donorId: d.id };
    },
    importTemplate(user, p) {
      const key = str(p.key, 40);
      if (!/^[a-z0-9-]+$/.test(key)) fail('Шаблон не знайдено');
      if (getMeta('tpl:' + key) || q('SELECT id FROM donors WHERE template_key = ?').get(key)) fail('Цей каталог уже додано', 409, 'exists');
      const n = importCatalog(key, null);
      if (n === null) fail('Шаблон не знайдено на сервері');
      return { count: n };
    },
    deleteProduct(user, p) {
      const pr = getProduct(str(p.id, 64)); if (!pr || !pr.active) fail('Товар не знайдено');
      const left = q('SELECT COALESCE(SUM(quantity),0) AS s FROM inventory WHERE product_id = ?').get(pr.id).s;
      if (left > 0) fail(`На складі ще ${left} шт. Спершу обнуліть кількість у «Редагувати → Наявність» — це запишеться в журнал як корекція.`, 409, 'stock');
      const open = q("SELECT DISTINCT d.no FROM deals d JOIN deal_items i ON i.deal_id = d.id WHERE d.status = 'new' AND i.product_id = ? ORDER BY d.no").all(pr.id).map(r => '№' + String(r.no).padStart(6, '0'));
      if (open.length) fail(`Товар є в неоплачених угодах: ${open.join(', ')}. Спершу приберіть його звідти.`, 409, 'deal');
      q('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(nowISO(), pr.id);
      return { productId: pr.id };
    },
    expense(user, p) {
      const a = needAccount(p.accountId);
      const amount = num(p.amount, 'Сума', { allowZero: false });
      const bal = balance(a.id);
      if (amount > bal + 1e-9) fail(`На рахунку ${a.name} лише ${bal}`, 409, 'balance');
      let takenBy, takenByUserId = null;
      if (p.takenByUserId) { const u = getUser(str(p.takenByUserId, 64)); if (!u || u.deleted) fail('Користувача не знайдено'); takenBy = u.name; takenByUserId = u.id; }
      else { takenBy = str(p.takenByName, 200); if (!takenBy) fail('Вкажіть, хто взяв кошти'); }
      const purpose = str(p.purpose, 1000); if (!purpose) fail('Вкажіть, на що взяли кошти');
      const at = new Date(p.at || Date.now()); if (isNaN(at)) fail('Невірна дата');
      addFin({ accountId: a.id, amount: -amount, type: 'expense', userId: user.id, at: at.toISOString(), takenBy, takenByUserId, purpose });
      return { amount, account: a.name };
    },
    deposit(user, p) {
      const a = needAccount(p.accountId);
      const amount = num(p.amount, 'Сума', { allowZero: false });
      const purpose = str(p.purpose, 1000); if (!purpose) fail('Вкажіть, звідки кошти');
      const at = new Date(p.at || Date.now()); if (isNaN(at)) fail('Невірна дата');
      addFin({ accountId: a.id, amount, type: 'deposit', userId: user.id, at: at.toISOString(), takenBy: user.name, takenByUserId: user.id, purpose });
      return { amount, account: a.name };
    },
    invest(user, p) { return investOp(user, p, 1); },
    repay(user, p) { return investOp(user, p, -1); },
    saveUser(user, p) {
      requireAdmin(user);
      const name = str(p.name, 200); if (!name) fail('Вкажіть імʼя');
      const role = p.role === 'admin' ? 'admin' : 'owner';
      const pin = str(p.pin, 20);
      const existing = p.id ? getUser(str(p.id, 64)) : null;
      if (p.id && (!existing || existing.deleted)) fail('Користувача не знайдено');
      if (!existing || pin) {
        if (!validPin(pin)) fail('PIN — від 4 до 8 цифр');
        const h = pinHash(pin);
        const clash = q('SELECT id FROM users WHERE pin_hash = ? AND active = 1 AND deleted = 0 AND id != ?').get(h, existing ? existing.id : '');
        if (clash && (!existing || existing.active)) fail('Такий PIN уже має інший активний користувач', 409, 'pin');
        if (existing) q('UPDATE users SET pin_hash = ? WHERE id = ?').run(h, existing.id);
        else { const id = newId('u_'); q('INSERT INTO users (id, name, role, pin_hash, active, deleted, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)').run(id, name, role, h, nowISO()); return { userId: id }; }
      }
      if (existing.role === 'admin' && role !== 'admin' && existing.active && activeAdmins(existing.id) === 0) fail('Має залишитися хоча б один активний адмін', 409, 'last_admin');
      q('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, existing.id);
      if (pin && existing.id !== user.id) q('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      return { userId: existing.id };
    },
    toggleUser(user, p) {
      requireAdmin(user);
      const u = getUser(str(p.id, 64)); if (!u || u.deleted) fail('Користувача не знайдено');
      if (u.id === user.id) fail('Себе деактивувати не можна');
      if (u.active) {
        if (u.role === 'admin' && activeAdmins(u.id) === 0) fail('Має залишитися хоча б один активний адмін', 409, 'last_admin');
        q('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
        q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      } else {
        if (q('SELECT id FROM users WHERE pin_hash = ? AND active = 1 AND deleted = 0 AND id != ?').get(u.pin_hash, u.id)) fail('PIN цього користувача вже зайнятий. Задайте новий PIN і збережіть.', 409, 'pin');
        q('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
      }
      return { userId: u.id };
    },
    deleteUser(user, p) {
      requireAdmin(user);
      const u = getUser(str(p.id, 64)); if (!u || u.deleted) fail('Користувача не знайдено');
      if (u.id === user.id) fail('Себе видалити не можна');
      if (u.active && u.role === 'admin' && activeAdmins(u.id) === 0) fail('Має залишитися хоча б один активний адмін', 409, 'last_admin');
      q('UPDATE users SET deleted = 1, active = 0, deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), user.id, u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      return { userId: u.id };
    },
    saveWarehouse(user, p) {
      const name = str(p.name, 100); if (!name) fail('Вкажіть назву складу');
      const id = p.id ? str(p.id, 64) : null;
      if (q('SELECT id FROM warehouses WHERE deleted = 0 AND lower(name) = lower(?) AND id != ?').get(name, id || '')) fail('Склад з такою назвою вже є');
      let w = id ? getWh(id) : null;
      if (id && (!w || w.deleted)) fail('Склад не знайдено');
      if (w && w.is_default && !p.isDefault) fail('Має бути один склад за замовчуванням. Позначте інший склад зірочкою.');
      if (w && !w.active && p.isDefault) fail('Спершу активуйте склад');
      if (!w) { const nid = newId('w_'); q('INSERT INTO warehouses (id, name, is_default, active, deleted, created_at) VALUES (?, ?, 0, 1, 0, ?)').run(nid, name, nowISO()); w = getWh(nid); }
      q('UPDATE warehouses SET name = ? WHERE id = ?').run(name, w.id);
      if (p.isDefault) { q('UPDATE warehouses SET is_default = 0').run(); q('UPDATE warehouses SET is_default = 1 WHERE id = ?').run(w.id); }
      return { warehouseId: w.id };
    },
    toggleWarehouse(user, p) {
      const w = getWh(str(p.id, 64)); if (!w || w.deleted) fail('Склад не знайдено');
      if (w.active) { const e = whBlock(w); if (e) fail(e, 409, 'warehouse'); q('UPDATE warehouses SET active = 0 WHERE id = ?').run(w.id); }
      else q('UPDATE warehouses SET active = 1 WHERE id = ?').run(w.id);
      return { warehouseId: w.id };
    },
    deleteWarehouse(user, p) {
      const w = getWh(str(p.id, 64)); if (!w || w.deleted) fail('Склад не знайдено');
      const e = whBlock(w); if (e) fail(e, 409, 'warehouse');
      q('UPDATE warehouses SET deleted = 1, active = 0, is_default = 0, deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowISO(), user.id, w.id);
      return { warehouseId: w.id };
    },
    setDefaultWarehouse(user, p) {
      const w = needActiveWh(str(p.id, 64));
      q('UPDATE warehouses SET is_default = 0').run();
      q('UPDATE warehouses SET is_default = 1 WHERE id = ?').run(w.id);
      return { warehouseId: w.id };
    },
  };

  const runInTx = db.transaction((type, user, payload) => {
    const r = actions[type](user, payload || {});
    bump();
    return r;
  });
  function run(type, user, payload) {
    if (!Object.prototype.hasOwnProperty.call(actions, type)) fail('Невідома дія', 404, 'unknown_action');
    return runInTx(type, user, payload);
  }

  // ---------- snapshot для клієнта (без хешів PIN) ----------
  function snapshot(user) {
    const b = v => !!v;
    const users = q('SELECT id, name, role, active, deleted FROM users ORDER BY created_at').all()
      .map(u => ({ id: u.id, name: u.name, role: u.role, active: b(u.active), deleted: b(u.deleted) }));
    const warehouses = q('SELECT * FROM warehouses ORDER BY created_at').all()
      .map(w => ({ id: w.id, name: w.name, isDefault: b(w.is_default), active: b(w.active), deleted: b(w.deleted) }));
    const photos = {};
    q('SELECT product_id, url FROM product_photos ORDER BY position, id').all().forEach(r => { (photos[r.product_id] ||= []).push(r.url); });
    const products = q('SELECT * FROM products ORDER BY created_at').all().map(p => ({
      id: p.id, catalogNumber: p.catalog_number, name: p.name, price: p.price, condition: p.condition,
      defective: b(p.defective), analog: b(p.analog), notes: p.notes, block: p.block ?? null, active: b(p.active), photos: photos[p.id] || [],
      art: p.art, donorId: p.donor_id || null, group: p.grp || '', sub: p.sub || '', manufacturer: p.manufacturer || '',
      marketPrice: p.market_price ?? null, compat: p.compat || '', exUrl: p.ex_url || null, exImg: p.ex_img || null }));
    const donors = q('SELECT * FROM donors WHERE deleted = 0 ORDER BY created_at').all().map(d => ({
      id: d.id, make: d.make, model: d.model, years: d.years, engine: d.engine, color: d.color, vin: d.vin, notes: d.notes, cost: d.cost ?? null, templateKey: d.template_key || null }));
    let templates = [];
    try { templates = fs.readdirSync(TEMPLATES_DIR).filter(f => /^[a-z0-9-]+\.json$/.test(f)).map(f => f.slice(0, -5)); } catch (e) { /* немає папки */ }
    const inventory = q('SELECT product_id, warehouse_id, quantity FROM inventory').all()
      .map(r => ({ productId: r.product_id, warehouseId: r.warehouse_id, quantity: r.quantity }));
    const invTx = q('SELECT * FROM inventory_transactions ORDER BY at').all().map(t => ({
      id: t.id, productId: t.product_id, warehouseId: t.warehouse_id, change: t.change, before: t.before_qty, after: t.after_qty,
      type: t.type, dealId: t.deal_id, userId: t.user_id, at: t.at }));
    const itemsBy = {};
    q('SELECT * FROM deal_items ORDER BY position, id').all().forEach(i => {
      (itemsBy[i.deal_id] ||= []).push({ productId: i.product_id, warehouseId: i.warehouse_id, quantity: i.quantity, price: i.price });
    });
    const retBy = {};
    q('SELECT * FROM deal_returns ORDER BY at').all().forEach(r => { (retBy[r.deal_id] ||= []).push({ no: r.return_no, productId: r.product_id, warehouseId: r.warehouse_id, quantity: r.quantity, value: r.value, accountId: r.account_id, refund: r.refund, reason: r.reason, userId: r.user_id, at: r.at }); });
    const deals = q('SELECT * FROM deals ORDER BY no').all().map(d => ({ returns: retBy[d.id] || [],
      id: d.id, no: d.no, customerName: d.customer_name, deliveryType: d.delivery_type, deliveryDetails: d.delivery_details,
      items: itemsBy[d.id] || [], total: d.total, currency: d.currency || 'UAH', paymentStatus: d.payment_status, status: d.status,
      createdBy: d.created_by, createdAt: d.created_at, paidAt: d.paid_at,
      payment: d.pay_account ? { accountId: d.pay_account, amount: d.pay_amount, currency: d.pay_currency, rate: d.pay_rate } : null,
      editedAt: d.edited_at, editedBy: d.edited_by, cancelledAt: d.cancelled_at, cancelledBy: d.cancelled_by, cancelReason: d.cancel_reason }));
    const finTx = q('SELECT * FROM financial_transactions ORDER BY at').all().map(t => ({
      id: t.id, accountId: t.account_id, amount: t.amount, currency: t.currency, type: t.type, dealId: t.deal_id,
      dealAmountUah: t.deal_amount_uah, dealCurrency: t.deal_currency || (t.deal_id ? 'UAH' : null), rate: t.rate, userId: t.user_id, at: t.at, takenBy: t.taken_by,
      takenByUserId: t.taken_by_user_id, purpose: t.purpose, investorUserId: t.investor_user_id || null }));
    return {
      version: version(),
      me: { id: user.id, name: user.name, role: user.role },
      data: { invChecks: Object.fromEntries(q("SELECT key, value FROM meta WHERE key LIKE 'inv:%'").all().map(r => [r.key.slice(4), JSON.parse(r.value)])), users, warehouses, donors, templates: templateInfo(templates), products, inventory, invTx, deals, finTx, nextDealNo: Number(getMeta('next_deal_no')), priceCurrency: PRICE_CURRENCY },
    };
  }

  // Каталог запчастин із шаблону → загальний склад (кількість 0, без донора). Повертає кількість або null.
  function importCatalog(key, donorId) {
    const file = path.join(TEMPLATES_DIR, key + '.json');
    if (!fs.existsSync(file)) return null;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cols = 'catalog_number, name, price, condition, defective, notes, block, donor_id, grp, sub, analog, manufacturer, market_price, compat, ex_url, ex_img';
    let n = 0;
    for (const r of t.parts || []) {
      const st = STATES[r.c] || STATES.used;
      insertProduct(newId('p_'), cols, [str(r.o, 100).toUpperCase(), str(r.n, 300), 0, st[0], st[2], '', null, donorId,
        GROUPS.includes(r.g) ? r.g : '', str(r.s, 100), st[1], str(r.m, 100), Number.isFinite(r.mp) ? round2(r.mp) : null,
        (Array.isArray(r.cp) ? r.cp : []).map(x => str(x, 120)).filter(Boolean).join('\n'), exUrl(r.u), exUrl(r.i)]);
      n++;
    }
    setMeta('tpl:' + key, new Date().toISOString());
    setMeta('tplx:' + key, 'import');
    return n;
  }
  const exUrl = u => (typeof u === 'string' && /^https:\/\/aleto\.ua\/[\w\-./%]+$/.test(u) ? u : null);
  // Каталог, завантажений раніше (v14/v15) — доповнюємо посиланнями на приклад і фото-приклад
  function enrichCatalog(key) {
    if (getMeta('tplx:' + key) || !getMeta('tpl:' + key)) return 0;
    const file = path.join(TEMPLATES_DIR, key + '.json');
    if (!fs.existsSync(file)) return 0;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    let n = 0;
    const byName = q("SELECT id FROM products WHERE ex_url IS NULL AND name = ? AND catalog_number = ? ORDER BY created_at LIMIT 1");
    const byCode = q("SELECT id FROM products WHERE ex_url IS NULL AND catalog_number = ? AND market_price = ? ORDER BY created_at LIMIT 1");
    const up = q('UPDATE products SET ex_url = ?, ex_img = ? WHERE id = ?');
    for (const r of t.parts || []) {
      if (!r.u) continue;
      const code = str(r.o, 100).toUpperCase();
      const row = byName.get(str(r.n, 300), code) || (code && Number.isFinite(r.mp) ? byCode.get(code, round2(r.mp)) : null);
      if (row) { up.run(exUrl(r.u), exUrl(r.i), row.id); n++; }
    }
    setMeta('tplx:' + key, String(n));
    return n;
  }
  // Під час запуску: усі шаблони з папки templates, яких ще немає в базі, додаються в загальний каталог
  function ensureCatalog() {
    const done = [];
    let keys = [];
    try { keys = fs.readdirSync(TEMPLATES_DIR).filter(f => /^[a-z0-9-]+\.json$/.test(f)).map(f => f.slice(0, -5)); } catch (e) { return done; }
    if (!q('SELECT COUNT(*) AS c FROM users').get().c) return done;
    for (const key of keys) {
      if (getMeta('tpl:' + key)) { if (!getMeta('tplx:' + key)) db.transaction(() => { if (enrichCatalog(key)) bump(); })(); continue; }
      db.transaction(() => {
        // уже імпортовано раніше через донора-шаблон (v14) — не дублюємо
        if (q('SELECT id FROM donors WHERE template_key = ?').get(key)) { setMeta('tpl:' + key, 'donor'); if (enrichCatalog(key)) bump(); return; }
        const n = importCatalog(key, null);
        if (n) { bump(); done.push({ key, title: templateInfo([key])[0].title, count: n }); }
      })();
    }
    return done;
  }

  // назва й кількість запчастин шаблону (кеш, файл читається один раз)
  const tplCache = {};
  function templateInfo(keys) {
    return keys.map(k => {
      if (!tplCache[k]) { try { const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, k + '.json'), 'utf8')); tplCache[k] = { key: k, title: t.title || k, count: (t.parts || []).length }; } catch (e) { tplCache[k] = { key: k, title: k, count: 0 }; } }
      return tplCache[k];
    });
  }

  // ---------- auth ----------
  function login(pin) {
    if (!validPin(pin)) return null;
    return q('SELECT * FROM users WHERE pin_hash = ? AND active = 1 AND deleted = 0').get(pinHash(pin)) || null;
  }

  // ---------- seeding ----------
  function seedIfEmpty({ adminName, adminPin, demo }) {
    if (q('SELECT COUNT(*) AS c FROM users').get().c > 0) return false;
    const t = db.transaction(() => {
      const at = nowISO();
      if (!demo) {
        if (!validPin(adminPin)) throw new Error('ADMIN_PIN має бути від 4 до 8 цифр');
        q('INSERT INTO users (id, name, role, pin_hash, active, deleted, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)').run('u_admin', adminName, 'admin', pinHash(adminPin), at);
        q('INSERT INTO warehouses (id, name, is_default, active, deleted, created_at) VALUES (?, ?, 1, 1, 0, ?)').run('w_1', 'Склад 1', at);
        return;
      }
      seedDemo();
    });
    t();
    return true;
  }

  function seedDemo() {
    const D = 86400000, base = Date.now();
    const at = (daysAgo, h, m) => { const d = new Date(base - daysAgo * D); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const U = (id, name, role, pin, active) => q('INSERT INTO users (id, name, role, pin_hash, active, deleted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, name, role, pinHash(pin), active ? 1 : 0, at(40, 9, 0));
    U('u1', 'Богдан Анатолійович', 'admin', '1111', true);
    U('u2', 'Олександр Коваленко', 'owner', '2222', true);
    U('u3', 'Ігор Савчук', 'owner', '3333', false);
    [['w1', 'Склад 1', 1], ['w2', 'Склад 2', 0], ['w3', 'Склад 3', 0]].forEach(([id, n, d], i) =>
      q('INSERT INTO warehouses (id, name, is_default, active, deleted, created_at) VALUES (?, ?, ?, 1, 0, ?)').run(id, n, d, at(40, 9, i)));
    let n = 0;
    const P = (id, code, name, price, cond, def, notes, stock) => {
      n++;
      q('INSERT INTO products (id, catalog_number, name, price, condition, defective, notes, block, art, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(id, code, name, price, cond, def ? 1 : 0, notes, (n * 3) % 20 + 1, n, at(30, 10, n), at(30, 10, n));
      setMeta('next_art', n + 1);
      stock.forEach(([w, qn], i) => changeInv(id, w, qn, 'receipt', i % 2 ? 'u2' : 'u1', null, at(24 - i * 2 - n, 10, 15)));
    };
    P('p1', '8K0407253F', 'Ричаг передній Audi A4 B8', 85, 'used', false, 'Знято з авто 2012 р., пробіг 180 тис. км. Сайлентблоки цілі.', [['w1', 3], ['w2', 1]]);
    P('p2', '8K0941003', 'Фара ліва Audi A4 B8', 290, 'used', false, 'Без подряпин, кріплення цілі.', [['w2', 2]]);
    P('p3', '8K0941003', 'Фара ліва Audi A4 B8 (тріщина)', 120, 'used', true, 'Тріщина корпусу знизу, світить нормально.', [['w2', 1]]);
    P('p4', '8K0927803', 'Датчик ABS передній Audi A4 B8', 35, 'used', false, '', [['w1', 8]]);
    P('p5', '3AB857508', 'Дзеркало праве VW Passat B7', 70, 'used', false, 'Електропривід і підігрів працюють.', [['w3', 1]]);
    P('p6', '5E0823031', 'Капот Skoda Octavia A7', 230, 'used', false, 'Колір 9P9P.', [['w1', 1]]);
    P('p7', '', 'Підкрилок передній лівий Octavia A7', 15, 'used', false, '', [['w3', 2]]);
    P('p8', '51127312747', 'Бампер задній BMW F30', 170, 'used', true, 'Подряпини, потребує фарбування.', [['w2', 1]]);
    P('p9', '28100-0V010', 'Стартер Toyota Camry 2.5', 100, 'used', false, 'Перевірений на стенді.', [['w2', 1]]);
    P('p10', '1K0615301AA', 'Диск гальмівний передній VW Golf 6', 32, 'new', false, 'Новий, в упаковці.', [['w1', 4]]);
    P('p11', '6Q0959801', 'Блок склопідйомника VW Polo', 22, 'used', false, '', [['w3', 3]]);
    [['CASH_UAH', 124100], ['CASH_USD', 2280], ['CRYPTO_USDT', 4520], ['FOP_UAH', 66700]]
      .forEach(([a, v]) => addFin({ accountId: a, amount: v, type: 'opening', userId: 'u1', at: at(30, 9, 0), purpose: 'Початковий залишок' }));
    const mk = (no, cust, del, det, items, when, uid, pay) => {
      const id = 'd' + no;
      const total = items.reduce((s, [, , qn, pr]) => s + qn * pr, 0);
      q(`INSERT INTO deals (id, no, customer_name, delivery_type, delivery_details, total, currency, payment_status, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unpaid', 'new', ?, ?)`)
        .run(id, no, cust, del, det, total, PRICE_CURRENCY, uid, when);
      insertItems(id, items.map(([p, w, qn, pr]) => ({ productId: p, warehouseId: w, quantity: qn, price: pr })));
      items.forEach(([p, w, qn]) => changeInv(p, w, -qn, 'sale', uid, id, when));
      if (pay) {
        const [acc, amt, payAt] = pay; const rate = calcRate(ACC[acc].currency, PRICE_CURRENCY, amt, total);
        addFin({ accountId: acc, amount: amt, type: 'sale', dealId: id, dealAmountUah: total, dealCurrency: PRICE_CURRENCY, rate, userId: uid, at: payAt });
        q(`UPDATE deals SET payment_status='paid', status='done', paid_at=?, pay_account=?, pay_amount=?, pay_currency=?, pay_rate=? WHERE id=?`).run(payAt, acc, amt, ACC[acc].currency, rate, id);
      }
    };
    mk(120, 'Сергій Бондар', 'delivery', 'Нова Пошта, відділення №3, Львів, +380 50 111 22 33, Сергій Бондар', [['p6', 'w1', 1, 230], ['p8', 'w2', 1, 170]], at(6, 14, 20), 'u1', ['FOP_UAH', 16500, at(5, 11, 5)]);
    mk(121, 'Віктор Шевчук', 'pickup', '', [['p4', 'w1', 2, 35]], at(3, 12, 40), 'u2', ['CASH_USD', 70, at(3, 12, 45)]);
    mk(122, 'Андрій Мельник', 'pickup', '', [['p10', 'w1', 1, 32]], at(1, 16, 10), 'u1', ['CASH_UAH', 1300, at(1, 16, 12)]);
    mk(123, 'Олег Коваль', 'pickup', '', [['p9', 'w2', 1, 100]], at(1, 17, 30), 'u2', null);
    mk(124, 'Іван Петренко', 'delivery', 'Нова Пошта, відділення №15, Київ, +380 67 123 45 67, Іван Петренко', [['p1', 'w1', 1, 85], ['p2', 'w2', 1, 290], ['p4', 'w1', 2, 35]], at(0, 9, 42), 'u1', null);
    setMeta('next_deal_no', 125);
  }

  return { run, snapshot, login, version, getUser, seedIfEmpty, ensureCatalog, AppError };
}

module.exports = { createLogic, AppError };
