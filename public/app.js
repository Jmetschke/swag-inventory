const today = new Date().toISOString().slice(0, 10);
let items = [];

document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);

loadItems().then(() => {
  addLineItem('pullItems', 1);
  addLineItem('receiptItems', 0);
  refreshInventory();
  runWeeklyReport();
  refreshAudit();
  refreshAuditHistory();
  refreshEntries();
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
  const itemLabel = containerId === 'pullItems' ? 'Item Pulled' : 'Item';
  const qtyLabel = containerId === 'pullItems' ? 'QTY' : 'QTY';
  const row = document.createElement('div');
  row.className = 'line-item';
  row.innerHTML = `
    <label>${itemLabel} <select name="itemId" required>${itemOptions()}</select></label>
    <label>${qtyLabel} <input type="number" name="qty" min="${minQty}" required /></label>
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

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', async () => {
    document.querySelectorAll('.tab-button').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === button.dataset.tab));
    if (button.dataset.tab === 'auditTab') {
      await refreshAudit();
      await refreshAuditHistory();
    } else if (button.dataset.tab === 'entriesTab') {
      await refreshEntries();
    }
  });
});

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
  await refreshAudit();
  await runWeeklyReport();
});

document.getElementById('pullForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.items = getLineItems('pullItems');
  await postJson('/api/pulls', body);
  e.target.reset(); resetLineItems('pullItems', 1); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory(); await refreshAudit(); await runWeeklyReport(); await refreshEntries();
});

document.getElementById('receiptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.items = getLineItems('receiptItems');
  await postJson('/api/receipts', body);
  e.target.reset(); resetLineItems('receiptItems', 0); document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);
  await refreshInventory(); await refreshAudit();
});

document.getElementById('refresh').addEventListener('click', refreshInventory);
document.getElementById('runWeekly').addEventListener('click', runWeeklyReport);
document.getElementById('refreshEntries').addEventListener('click', refreshEntries);
document.getElementById('uploadEntries').addEventListener('click', uploadEntriesFile);
document.getElementById('printInventory').addEventListener('click', () => {
  const asOf = document.getElementById('asOf').value || today;
  const startDate = document.getElementById('inventoryStart').value || asOf;
  const endDate = document.getElementById('inventoryEnd').value || asOf;
  printReport('Calculated Inventory', `As of ${asOf} | Usage ${startDate} to ${endDate}`, 'inventoryTable');
});
document.getElementById('printWeekly').addEventListener('click', () => {
  const startDate = document.getElementById('weekStart').value || today;
  const endDate = document.getElementById('weekEnd').value || today;
  printReport('Weekly Usage Report', `${startDate} to ${endDate}`, 'weeklyTable');
});
document.getElementById('auditDate').addEventListener('change', refreshAudit);
document.getElementById('closeAuditDialog').addEventListener('click', () => document.getElementById('auditDialog').close());
document.getElementById('auditHistoryTable').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-audit-id]');
  if (button) await openAuditDetails(button.dataset.auditId);
});
document.getElementById('auditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  body.counts = [...document.querySelectorAll('#auditTable input[name="countedQty"]')]
    .map(input => ({
      itemId: Number(input.dataset.itemId),
      countedQty: Number(input.value === '' ? input.dataset.knownCount : input.value)
    }))
    .filter(count => Number.isInteger(count.countedQty));
  await postJson('/api/audits', body);
  [...document.querySelectorAll('#auditTable input[name="countedQty"]')].forEach(input => input.value = '');
  await refreshInventory();
  await refreshAudit();
  await refreshAuditHistory();
});

async function refreshInventory() {
  const asOf = document.getElementById('asOf').value || today;
  const startDate = document.getElementById('inventoryStart').value || asOf;
  const endDate = document.getElementById('inventoryEnd').value || asOf;
  const params = new URLSearchParams({ asOf, startDate, endDate });
  const rows = await action(`/api/inventory?${params}`);
  renderTable('inventoryTable', ['Item','Starting','Received','Pulled','Used In Range','Calculated On Hand'], rows.map(r => [r.name, r.startingQuantity, r.totalReceived, r.totalPulled, r.pulledInRange, r.calculatedOnHand]));
}

async function refreshEntries() {
  const entries = await action('/api/entries?limit=2000');
  renderTable('entriesTable', ['Date','Item Pulled','QTY','Pulled By','Purpose','Notes'], entries.map(entry => [
    entry.date,
    entry.itemPulled,
    entry.qty,
    entry.pulledBy || '',
    entry.purpose,
    entry.notes || ''
  ]));
}

async function uploadEntriesFile() {
  const input = document.getElementById('entriesUpload');
  const status = document.getElementById('entriesUploadStatus');
  const file = input.files[0];
  if (!file) {
    status.textContent = 'Choose an .xlsx file first.';
    return;
  }
  status.textContent = 'Reading entries...';
  try {
    const result = await action('/api/entries/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'X-File-Name': file.name
      },
      body: await file.arrayBuffer()
    });
    status.textContent = `Inserted ${result.inserted} new entries. Skipped ${result.skipped} duplicates.`;
    input.value = '';
    await refreshEntries();
    await refreshInventory();
    await refreshAudit();
    await runWeeklyReport();
  } catch (err) {
    status.textContent = err.message;
  }
}

async function refreshAudit() {
  const countedDate = document.getElementById('auditDate').value || today;
  const params = new URLSearchParams({ asOf: countedDate, startDate: countedDate, endDate: countedDate });
  const rows = await action(`/api/inventory?${params}`);
  const table = document.getElementById('auditTable');
  table.innerHTML = `
    <thead><tr><th>Item</th><th>Known Count</th><th>Last Audit</th><th>Counted Number</th></tr></thead>
    <tbody>${rows.map(row => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td>${row.calculatedOnHand}</td>
        <td>${row.lastCountedDate || ''}</td>
        <td><input type="number" name="countedQty" min="0" data-item-id="${row.id}" data-known-count="${row.calculatedOnHand}" placeholder="${row.calculatedOnHand}" /></td>
      </tr>
    `).join('')}</tbody>
  `;
}

async function refreshAuditHistory() {
  const audits = await action('/api/audits');
  renderTable('auditHistoryTable', ['Date','Counted By','Items','Notes','Details'], audits.map(audit => [
    escapeHtml(audit.countedDate),
    escapeHtml(audit.countedBy || ''),
    audit.itemCount,
    escapeHtml(audit.notes || ''),
    `<button type="button" class="secondary" data-audit-id="${audit.id}">View</button>`
  ]), { allowHtml: true });
}

async function openAuditDetails(id) {
  const audit = await action(`/api/audits/${id}`);
  document.getElementById('auditDialogTitle').textContent = `Audit ${audit.countedDate}`;
  document.getElementById('auditDialogMeta').textContent = [
    audit.countedBy ? `Counted by ${audit.countedBy}` : '',
    audit.notes || ''
  ].filter(Boolean).join(' | ');
  renderTable('auditDetailTable', ['Item','Counted Number'], audit.rows.map(row => [row.item, row.countedQty]));
  document.getElementById('auditDialog').showModal();
}

async function runWeeklyReport() {
  const startDate = document.getElementById('weekStart').value || today;
  const endDate = document.getElementById('weekEnd').value || today;
  const report = await action(`/api/reports/weekly-usage?startDate=${startDate}&endDate=${endDate}`);
  renderTable('weeklyTable', ['Item','Used QTY'], report.rows.map(r => [r.name, r.usedQty]));
}

function printReport(title, subtitle, tableId) {
  const table = document.getElementById(tableId);
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) return;
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #222; margin: 24px; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          p { margin: 0 0 18px; color: #555; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border-bottom: 1px solid #ccc; padding: 7px; text-align: left; }
          th { background: #f0f2f5; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        ${table.outerHTML}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function renderTable(id, headers, rows, options = {}) {
  const table = document.getElementById(id);
  table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${options.allowHtml ? (cell ?? '') : escapeHtml(cell ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
