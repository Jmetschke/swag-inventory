const today = new Date().toISOString().slice(0, 10);
let items = [];

document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);

loadItems().then(() => {
  addLineItem('pullItems', 1);
  addLineItem('receiptItems', 0);
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

async function loadItems() {
  items = await action('/api/items');
  refreshItemSelects();
}

function itemOptions() {
  return items.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
}

function refreshItemSelects() {
  for (const select of document.querySelectorAll('select[name="itemId"]')) {
    const selected = select.value;
    select.innerHTML = itemOptions();
    if (items.some(item => String(item.id) === selected)) {
      select.value = selected;
    }
  }
}

function addLineItem(containerId, minQty) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = 'line-item';
  row.innerHTML = `
    <label>Item <select name="itemId" required>${itemOptions()}</select></label>
    <label>QTY <input type="number" name="qty" min="${minQty}" required /></label>
    <button type="button" class="secondary remove-line">Remove</button>
  `;
  row.querySelector('.remove-line').addEventListener('click', () => {
    if (container.children.length > 1) row.remove();
  });
  container.appendChild(row);
}

function getLineItems(containerId) {
  return [...document.querySelectorAll(`#${containerId} .line-item`)].map(row => ({
    itemId: Number(row.querySelector('select[name="itemId"]').value),
    qty: Number(row.querySelector('input[name="qty"]').value)
  }));
}

function resetLineItems(containerId, minQty) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  addLineItem(containerId, minQty);
}

async function postJson(url, body) {
  return action(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

document.getElementById('addPullItem').addEventListener('click', () => addLineItem('pullItems', 1));
document.getElementById('addReceiptItem').addEventListener('click', () => addLineItem('receiptItems', 0));

document.getElementById('itemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.startingQuantity = Number(body.startingQuantity || 0);
  body.reorderLevel = Number(body.reorderLevel || 0);
  await postJson('/api/items', body);
  e.target.reset();
  e.target.querySelector('input[name="startingDate"]').value = today;
  await loadItems();
  await refreshInventory();
  await runWeeklyReport();
});

document.getElementById('pullForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.items = getLineItems('pullItems');
  await postJson('/api/pulls', body);
  e.target.reset(); resetLineItems('pullItems', 1); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory(); await runWeeklyReport();
});

document.getElementById('receiptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.items = getLineItems('receiptItems');
  await postJson('/api/receipts', body);
  e.target.reset(); resetLineItems('receiptItems', 0); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory();
});

document.getElementById('refresh').addEventListener('click', refreshInventory);
document.getElementById('runWeekly').addEventListener('click', runWeeklyReport);

async function refreshInventory() {
  const asOf = document.getElementById('asOf').value || today;
  const startDate = document.getElementById('inventoryStart').value || asOf;
  const endDate = document.getElementById('inventoryEnd').value || asOf;
  const params = new URLSearchParams({ asOf, startDate, endDate });
  const rows = await action(`/api/inventory?${params}`);
  renderTable('inventoryTable', ['Item','Starting','Received','Pulled','Used In Range','Calculated On Hand'], rows.map(r => [r.name, r.startingQuantity, r.totalReceived, r.totalPulled, r.pulledInRange, r.calculatedOnHand]));
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
