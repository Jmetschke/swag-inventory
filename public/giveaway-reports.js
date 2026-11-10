(() => {
  const el = name => document.getElementById(`giveawayReport${name}`);
  const fields = ['Event', 'Employee', 'Item'];
  let rows = [];
  let loaded = false;
  let loading = false;
  let refreshAgain = false;
  const normalized = value => String(value).trim().toLowerCase();
  const quantity = value => Number(value).toLocaleString();

  function render() {
    const filters = fields.map(field => normalized(el(field).value));
    const filtered = filters.some(Boolean);
    const events = new Map();
    for (const row of rows) {
      const key = JSON.stringify([normalized(row.event), row.date]);
      if (!events.has(key)) events.set(key, { name: row.event, date: row.date, total: 0, matched: 0, employees: new Map() });
      const event = events.get(key);
      event.total += Number(row.qty);
      if (![row.event, row.employee, row.itemName].every((value, index) => normalized(value).includes(filters[index]))) continue;
      event.matched += Number(row.qty);
      const employeeKey = normalized(row.employee);
      if (!event.employees.has(employeeKey)) event.employees.set(employeeKey, { name: row.employee, total: 0, items: new Map() });
      const employee = event.employees.get(employeeKey);
      employee.total += Number(row.qty);
      if (!employee.items.has(row.itemId)) employee.items.set(row.itemId, { name: row.itemName, qty: 0 });
      employee.items.get(row.itemId).qty += Number(row.qty);
    }
    const cards = [...events.values()].filter(event => event.employees.size)
      .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    el('Summary').textContent = loaded
      ? `${cards.length} event card${cards.length === 1 ? '' : 's'} · ${quantity(cards.reduce((sum, event) => sum + event.matched, 0))} ${filtered ? 'matching items' : 'items given away'}` : '';
    el('Cards').innerHTML = cards.length ? cards.map(event => `
      <article class="card giveaway-event-card">
        <div class="giveaway-event-heading">
          <div><h3>${escapeHtml(event.name)}</h3><p>${escapeHtml(event.date)}</p></div>
          <div class="giveaway-event-total"><span>Total given away</span><strong>${quantity(event.total)}</strong></div>
        </div>
        ${filtered ? `<p class="giveaway-match-total">Matching items: <strong>${quantity(event.matched)}</strong></p>` : ''}
        ${[...event.employees.values()].sort((a, b) => a.name.localeCompare(b.name)).map(employee => `
          <section class="giveaway-employee">
            <h4>Employee: ${escapeHtml(employee.name)}</h4>
            <p>${filtered ? 'Matching employee quantity' : 'Employee total'}: ${quantity(employee.total)}</p>
            <table>
              <caption class="visually-hidden">${escapeHtml(event.name)} — ${escapeHtml(employee.name)} — ${escapeHtml(event.date)}</caption>
              <thead><tr><th scope="col">Item name</th><th scope="col">Number of items</th></tr></thead>
              <tbody>${[...employee.items.values()].sort((a, b) => a.name.localeCompare(b.name)).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${quantity(item.qty)}</td></tr>`).join('')}</tbody>
            </table>
          </section>`).join('')}
      </article>`).join('') : loaded ? `<p class="card">${rows.length ? 'No giveaways match your search. Try another name or clear the search.' : 'No giveaway items recorded yet. Add items and save tallies in Event Giveaways to see them here.'}</p>` : '';
  }

  async function refresh() {
    if (loading) { refreshAgain = true; return; }
    loading = true;
    el('Refresh').disabled = true;
    el('Status').textContent = 'Loading saved giveaways…';
    try {
      rows = await action('/api/giveaways/report');
      loaded = true;
      render();
      el('Status').textContent = `Saved tallies updated at ${new Date().toLocaleTimeString()}.`;
    } catch (err) {
      el('Status').textContent = `${loaded ? 'Showing previously loaded results. ' : ''}Unable to refresh: ${err.message}. Use Refresh to try again.`;
    } finally {
      loading = false;
      el('Refresh').disabled = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }
  fields.forEach(field => el(field).addEventListener('input', render));
  el('Clear').addEventListener('click', () => { fields.forEach(field => { el(field).value = ''; }); render(); });
  el('Refresh').addEventListener('click', refresh);
  document.querySelector('[data-tab="giveawayReportTab"]').addEventListener('click', refresh);
  const refreshIfActive = () => { if (isTabActive('giveawayReportTab')) void refresh(); };
  window.addEventListener('giveaways-saved', refreshIfActive);
  window.addEventListener('online', refreshIfActive);
  setInterval(() => { if (!document.hidden) refreshIfActive(); }, 30000);
})();
