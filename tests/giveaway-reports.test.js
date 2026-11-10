const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const fixture = [
  { event: 'Expo', date: '2026-10-07', employee: 'Jane', itemId: 1, itemName: 'Pens', qty: 5 },
  { event: 'EXPO', date: '2026-10-07', employee: 'Sam', itemId: 1, itemName: 'Pens', qty: 3 },
  { event: 'Expo', date: '2026-10-07', employee: 'Jane', itemId: 2, itemName: 'Bags', qty: 2 },
  { event: 'Expo', date: '2026-10-08', employee: 'Jane', itemId: 1, itemName: 'Pens', qty: 4 },
  { event: '<Fair>', date: '2026-10-07', employee: '<Alex>', itemId: 3, itemName: '<Mug>', qty: 0 }
];
function controller() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', handlers: {}, addEventListener(type, callback) { this.handlers[type] = callback; } });
    return elements.get(id);
  };
  const events = {};
  let response = structuredClone(fixture);
  const context = {
    document: { getElementById: element, querySelector: element },
    window: { addEventListener: (type, callback) => { events[type] = callback; } },
    isTabActive: () => true,
    setInterval() {},
    action: async () => { if (response instanceof Error) throw response; return response; },
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/giveaway-reports.js'), 'utf8'), context);
  return {
    el: name => element(`giveawayReport${name}`),
    refresh: () => element('giveawayReportRefresh').handlers.click(),
    search(name, value) { element(`giveawayReport${name}`).value = value; element(`giveawayReport${name}`).handlers.input(); },
    setResponse(value) { response = value; }, events
  };
}
test('report cards preserve event/date > employee > item hierarchy and filter totals', async () => {
  const c = controller();
  await c.refresh();
  assert.match(c.el('Summary').textContent, /3 event cards · 14 items given away/);
  assert.equal((c.el('Cards').innerHTML.match(/class="card giveaway-event-card"/g) || []).length, 3);
  assert.match(c.el('Cards').innerHTML, /Total given away<\/span><strong>10<\/strong>/);
  assert.match(c.el('Cards').innerHTML, /Employee: Jane/);
  assert.match(c.el('Cards').innerHTML, /Employee: Sam/);
  assert.match(c.el('Cards').innerHTML, /&lt;Fair&gt;/);
  assert.doesNotMatch(c.el('Cards').innerHTML, /<Mug>/);
  c.search('Item', ' pEN ');
  assert.match(c.el('Summary').textContent, /2 event cards · 12 matching items/);
  assert.doesNotMatch(c.el('Cards').innerHTML, />Bags</);
  assert.match(c.el('Cards').innerHTML, /Matching items: <strong>8<\/strong>/);
  assert.match(c.el('Cards').innerHTML, /Total given away<\/span><strong>10<\/strong>/);
  c.search('Employee', 'sam');
  c.search('Event', 'exp');
  assert.match(c.el('Summary').textContent, /1 event card · 3 matching items/);
  assert.doesNotMatch(c.el('Cards').innerHTML, /Employee: Jane/);
  assert.match(c.el('Cards').innerHTML, /Employee: Sam[\s\S]*Item name[\s\S]*<td>Pens<\/td><td>3<\/td>/);
  c.search('Event', 'missing');
  assert.match(c.el('Cards').innerHTML, /No giveaways match/);
  c.el('Clear').handlers.click();
  assert.match(c.el('Summary').textContent, /3 event cards/);
  c.setResponse(new Error('Offline'));
  await c.refresh();
  assert.match(c.el('Status').textContent, /Showing previously loaded results/);
  assert.match(c.el('Summary').textContent, /3 event cards/);
  c.setResponse([]);
  await c.refresh();
  assert.match(c.el('Cards').innerHTML, /No giveaway items recorded yet/);
});

test('report endpoint joins saved tallies, includes inactive items and corrections, and leaves inventory intact', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giveaway-report-test-'));
  process.env.TURSO_DATABASE_URL = `file:${path.join(directory, 'test.sqlite')}`;
  process.env.TURSO_DATABASE_TOKEN = 'test';
  const { db, initDb, all, run } = require('../server/src/db');
  try {
    await initDb();
    const items = await all('SELECT id FROM items ORDER BY id LIMIT 2');
    const itemId = items[0].id;
    await run('UPDATE items SET active = 0 WHERE id = ?', [itemId]);
    await run("INSERT INTO giveaway_forms(employee, event, date) VALUES ('Jane', 'Expo', '2026-10-07'), ('Sam', 'Expo', '2026-10-07'), ('Jane', 'Expo', '2026-10-08')");
    const forms = await all('SELECT id FROM giveaway_forms ORDER BY id');
    for (const [index, form] of forms.entries()) await run('INSERT INTO giveaway_items(form_id, item_id, qty) VALUES (?, ?, ?)', [form.id, itemId, index + 3]);
    await run('INSERT INTO giveaway_items(form_id, item_id, qty) VALUES (?, ?, 0)', [forms[0].id, items[1].id]);
    const before = await all('SELECT * FROM items');
    const router = require('../server/src/giveaways');
    const route = router.stack.find(layer => layer.route?.path === '/report');
    assert(router.stack.indexOf(route) < router.stack.findIndex(layer => layer.route?.path === '/:id'));
    const request = () => new Promise((resolve, reject) => route.route.stack[0].handle({}, { json: resolve }, reject));
    let rows = await request();
    assert.equal(rows.length, 4);
    assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 12);
    assert.equal(rows[0].date, '2026-10-08');
    assert(rows.every(row => row.event && row.employee && row.itemName && row.itemId && row.formId));
    await run('UPDATE giveaway_items SET qty = qty - 1 WHERE form_id = ? AND item_id = ?', [forms[0].id, itemId]);
    rows = await request();
    assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 11);
    assert.deepEqual(await all('SELECT * FROM items'), before);
    assert.equal((await all('SELECT COUNT(*) AS count FROM inventory_pulls'))[0].count, 0);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
