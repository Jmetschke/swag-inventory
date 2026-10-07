const router = require('express').Router();
const { db, all, run } = require('./db');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
async function getForm(id) {
  const [form] = await all('SELECT * FROM giveaway_forms WHERE id = ?', [id]);
  if (!form) throw fail('Giveaway form not found', 404);
  form.items = await all(`SELECT g.item_id AS itemId, i.name, g.qty FROM giveaway_items g
    JOIN items i ON i.id = g.item_id WHERE g.form_id = ? ORDER BY i.name`, [id]);
  return form;
}
router.get('/', async (req, res, next) => {
  try { res.json(await all('SELECT * FROM giveaway_forms ORDER BY date DESC, employee, event')); }
  catch (err) { next(err); }
});
router.post('/', async (req, res, next) => {
  try {
    const { employee, event, date } = req.body;
    if (![employee, event].every(v => typeof v === 'string' && v.trim() && v.trim().length <= 200)) throw fail('Employee and event names are required (maximum 200 characters).');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw fail('A valid date is required.');
    await run('INSERT INTO giveaway_forms(employee, event, date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [employee.trim(), event.trim(), date]);
    const [form] = await all('SELECT id FROM giveaway_forms WHERE employee = ? AND event = ? AND date = ?', [employee.trim(), event.trim(), date]);
    res.json(await getForm(form.id));
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) throw fail('Invalid form');
    res.json(await getForm(Number(req.params.id)));
  } catch (err) { next(err); }
});
router.post('/:id/operations', async (req, res, next) => {
  let tx;
  try {
    const formId = Number(req.params.id);
    const { id, itemId, delta } = req.body;
    if (!validId(formId) || !validId(itemId) || typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id) || !Number.isSafeInteger(delta) || Math.abs(delta) > 1000000) throw fail('Invalid tally change.');
    tx = await db.transaction('write');
    const execute = (sql, args) => tx.execute({ sql, args });
    const previous = (await execute('SELECT * FROM giveaway_operations WHERE id = ?', [id])).rows[0];
    if (previous) {
      if (Number(previous.form_id) !== formId || Number(previous.item_id) !== Number(itemId) || Number(previous.delta) !== delta) throw fail('Tally request identifier already used.', 409);
    } else {
      if (!(await execute('SELECT id FROM giveaway_forms WHERE id = ?', [formId])).rows.length) throw fail('Giveaway form not found', 404);
      const existing = (await execute('SELECT qty FROM giveaway_items WHERE form_id = ? AND item_id = ?', [formId, Number(itemId)])).rows[0];
      if (!existing && !(await execute('SELECT id FROM items WHERE id = ? AND active = 1', [Number(itemId)])).rows.length) throw fail('Choose an active inventory item.');
      const qty = Number(existing?.qty || 0) + delta;
      if (qty < 0 || qty > 1000000000) throw fail('This change would put the total outside the allowed range. Refresh the form and try again.', 409);
      await execute('INSERT INTO giveaway_items(form_id, item_id, qty) VALUES (?, ?, ?) ON CONFLICT(form_id, item_id) DO UPDATE SET qty = excluded.qty', [formId, Number(itemId), qty]);
      await execute('INSERT INTO giveaway_operations(id, form_id, item_id, delta) VALUES (?, ?, ?, ?)', [id, formId, Number(itemId), delta]);
    }
    await tx.commit();
    res.json(await getForm(formId));
  } catch (err) { if (tx && !tx.closed) await tx.rollback(); next(err); }
  finally { if (tx) tx.close(); }
});
module.exports = router;
