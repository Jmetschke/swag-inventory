const today = new Date().toISOString().slice(0, 10);
const itemSelects = document.querySelectorAll('select[name="itemId"]');

document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);

action('/api/items').then(items => {
  for (const select of itemSelects) {
    select.innerHTML = items.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
  }
  refreshInventory();
  runWeeklyReport();
});

async function action(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function postJson(url, body) {
  return action(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

document.getElementById('pullForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.itemId = Number(body.itemId); body.qty = Number(body.qty);
  await postJson('/api/pulls', body);
  e.target.reset(); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory(); await runWeeklyReport();
});

document.getElementById('receiptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.itemId = Number(body.itemId); body.qty = Number(body.qty);
  await postJson('/api/receipts', body);
  e.target.reset(); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory();
});

document.getElementById('refresh').addEventListener('click', refreshInventory);
document.getElementById('runWeekly').addEventListener('click', runWeeklyReport);

async function refreshInventory() {
  const asOf = document.getElementById('asOf').value || today;
  const rows = await action(`/api/inventory?asOf=${asOf}`);
  renderTable('inventoryTable', ['Item','Starting','Received','Pulled','Calculated On Hand'], rows.map(r => [r.name, r.startingQuantity, r.totalReceived, r.totalPulled, r.calculatedOnHand]));
}

async function runWeeklyReport() {
  const startDate = document.getElementById('weekStart').value || today;
  const endDate = document.getElementById('weekEnd').value || today;
  const report = await action(`/api/reports/weekly-usage?startDate=${startDate}&endDate=${endDate}`);
  renderTable('weeklyTable', ['Item','Used QTY'], report.rows.map(r => [r.name, r.usedQty]));
}

function renderTable(id, headers, rows) {
  const table = document.getElementById(id);
  table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
