(() => {
  const el = id => document.getElementById(`giveaway${id}`);
  const cacheKey = 'swag-giveaway-cache-v1';
  const opPrefix = 'swag-giveaway-operation-';
  let cache = { forms: [], sheets: {}, catalog: [], current: null };
  let syncing = false;
  const status = message => { el('Status').textContent = message; };
  try { cache = JSON.parse(localStorage.getItem(cacheKey)) || cache; }
  catch { status('Browser storage is unavailable. Enable it to keep a safe backup of tallies.'); }
  function save() { localStorage.setItem(cacheKey, JSON.stringify(cache)); }
  function pending() {
    return Object.keys(localStorage).filter(key => key.startsWith(opPrefix))
      .map(key => JSON.parse(localStorage.getItem(key))).filter(Boolean)
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  async function request(path, body) {
    const response = await fetch(`/api/giveaways${path}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Unable to save'), { status: response.status });
    return data;
  }
  function options() {
    const employee = el('Employee').value.trim().toLowerCase();
    const event = el('Event').value.trim().toLowerCase();
    el('Employees').innerHTML = [...new Set(cache.forms.map(f => f.employee))].map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    el('Events').innerHTML = [...new Set(cache.forms.filter(f => !employee || f.employee.toLowerCase() === employee).map(f => f.event))].map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
    el('Saved').innerHTML = '<option value="">Select a saved form (event and date)</option>' + cache.forms
      .filter(f => (!employee || f.employee.toLowerCase() === employee) && (!event || f.event.toLowerCase() === event))
      .map(f => `<option value="${f.id}">${escapeHtml(`${f.employee} — ${f.event} — ${f.date}`)}</option>`).join('');
  }
  function render() {
    const form = cache.sheets[cache.current];
    el('Sheet').hidden = !form;
    if (!form) return;
    const rows = form.items.map(item => ({ ...item }));
    for (const op of pending().filter(op => op.formId === form.id)) {
      let row = rows.find(item => item.itemId === op.itemId);
      if (!row) { row = { itemId: op.itemId, name: op.name, qty: 0 }; rows.push(row); }
      row.qty += op.delta;
    }
    el('Title').textContent = `${form.employee} — ${form.event} — ${form.date}`;
    el('Total').textContent = `Total given away: ${rows.reduce((sum, row) => sum + row.qty, 0)}`;
    el('Item').innerHTML = '<option value="">Select an item</option>' + cache.catalog.filter(i => i.active && !rows.some(row => row.itemId === i.id)).map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
    el('Rows').innerHTML = rows.length ? rows.map(row => `<article class="giveaway-row" data-item="${row.itemId}">
      <h3>${escapeHtml(row.name)}</h3><div class="giveaway-counter">
      <button type="button" data-delta="-1" aria-label="Subtract one ${escapeHtml(row.name)}" ${row.qty <= 0 ? 'disabled' : ''}>−1</button>
      <strong aria-label="Given away">${row.qty}</strong>
      <button type="button" data-delta="1" aria-label="Give away one ${escapeHtml(row.name)}">+1</button></div>
      <form class="inline-fields" data-item="${row.itemId}"><label>Quantity <input name="quantity" type="number" min="1" max="1000000" step="1" value="1" required></label><button type="submit">Add</button></form>
      </article>`).join('') : '<p>Add inventory items to start tallying.</p>';
  }
  function choose(form) {
    cache.current = form.id;
    cache.sheets[form.id] = form;
    el('Employee').value = form.employee;
    el('Event').value = form.event;
    el('Date').value = form.date;
    save(); options(); render();
  }
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      for (const op of pending()) {
        status('Saving tallies…');
        let form;
        try { form = await request(`/${op.formId}/operations`, op); }
        catch (err) {
          if (err.status >= 400 && err.status < 500 && err.status !== 429) {
            localStorage.removeItem(opPrefix + op.id);
            cache.sheets[op.formId] = await request(`/${op.formId}`);
            save(); render();
            throw new Error(`Change not recorded for ${op.name}: ${err.message}`);
          }
          throw err;
        }
        cache.sheets[form.id] = form;
        // Save the acknowledged form before removing its durable retry record.
        save();
        localStorage.removeItem(opPrefix + op.id);
        render();
      }
      const [forms, catalog] = await Promise.all([request(''), action('/api/items')]);
      cache.forms = forms; cache.catalog = catalog;
      if (cache.current) cache.sheets[cache.current] = await request(`/${cache.current}`);
      save(); options(); render();
      status(pending().length ? 'Changes waiting to sync.' : 'All tallies saved. You can return to this form throughout the day.');
    } catch (err) {
      status(`${err.message}. ${pending().length ? 'Changes kept in this browser; reconnect and press Sync / Refresh. Do not clear browser data.' : 'Press Sync / Refresh to try again.'}`);
    } finally { syncing = false; }
  }
  function tally(itemId, delta) {
    try {
      const form = cache.sheets[cache.current];
      const item = cache.catalog.find(i => i.id === itemId) || form.items.find(i => i.itemId === itemId);
      if (!Number.isSafeInteger(delta) || Math.abs(delta) > 1000000) return;
      const qty = Number(form.items.find(i => i.itemId === itemId)?.qty || 0) + pending().filter(op => op.formId === form.id && op.itemId === itemId).reduce((sum, op) => sum + op.delta, 0);
      if (qty + delta < 0) return;
      const op = { id: crypto.randomUUID(), formId: form.id, itemId, delta, name: item.name, time: Math.max(Date.now(), ...pending().map(change => change.time + 1)) };
      localStorage.setItem(opPrefix + op.id, JSON.stringify(op));
      render(); status('Saved in this browser. Syncing…'); void sync();
    } catch { status('Unable to save in browser storage. This tally was not recorded. Enable browser storage and try again.'); }
  }
  el('Open').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { employee: el('Employee').value.trim(), event: el('Event').value.trim(), date: el('Date').value };
    const existing = cache.forms.find(f => f.employee.toLowerCase() === body.employee.toLowerCase() && f.event.toLowerCase() === body.event.toLowerCase() && f.date === body.date);
    try {
      if (existing && cache.sheets[existing.id]) choose(cache.sheets[existing.id]);
      else choose(await request('', body));
      void sync();
    } catch (err) { status(`Unable to open form: ${err.message}. New forms require a connection.`); }
  });
  el('Saved').addEventListener('change', async e => {
    if (!e.target.value) return;
    try { choose(cache.sheets[e.target.value] || await request(`/${e.target.value}`)); void sync(); }
    catch (err) { status(err.message); }
  });
  for (const name of ['Employee', 'Event']) el(name).addEventListener('input', options);
  for (const name of ['Employee', 'Event', 'Date']) el(name).addEventListener('change', async () => {
    const matchesFields = form => form.employee.toLowerCase() === el('Employee').value.trim().toLowerCase()
      && form.event.toLowerCase() === el('Event').value.trim().toLowerCase() && form.date === el('Date').value;
    const existing = cache.forms.find(matchesFields);
    if (!existing) return;
    try {
      const form = cache.sheets[existing.id] || await request(`/${existing.id}`);
      if (matchesFields(form)) { choose(form); void sync(); }
    } catch (err) { status(`Unable to reopen saved form: ${err.message}`); }
  });
  el('AddItem').addEventListener('submit', e => { e.preventDefault(); if (el('Item').value) tally(Number(el('Item').value), 0); });
  el('Rows').addEventListener('click', e => {
    const button = e.target.closest('[data-delta]');
    if (button) tally(Number(button.closest('[data-item]').dataset.item), Number(button.dataset.delta));
  });
  el('Rows').addEventListener('submit', e => { e.preventDefault(); tally(Number(e.target.dataset.item), Number(e.target.elements.quantity.value)); });
  el('Retry').addEventListener('click', sync);
  window.addEventListener('online', sync);
  window.addEventListener('storage', e => { if (e.key?.startsWith(opPrefix)) render(); });
  document.querySelector('[data-tab="giveawayTab"]').addEventListener('click', sync);
  const now = new Date();
  el('Date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  try { if (cache.sheets[cache.current]) choose(cache.sheets[cache.current]); options(); render(); }
  catch { status('Browser backup could not be restored. Reopen your saved form after connecting.'); }
  void sync();
  setInterval(() => {
    try { if (pending().length && !syncing) void sync(); }
    catch { status('Browser storage is unavailable. Enable it before tallying.'); }
  }, 15000);
})();
