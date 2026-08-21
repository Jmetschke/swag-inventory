const today = new Date().toISOString().slice(0, 10);
let items = [];
let analysisRows = [];

document.querySelectorAll('input[type="date"]').forEach(input => input.value = today);

loadItems().then(() => {
  renderAnalysisProducts();
  renderSkuManagement();
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

function itemOptions(includeInactive = false) {
  return items
    .filter(item => includeInactive || item.active)
    .map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`)
    .join('');
}

function refreshItemSelects() {
  for (const select of document.querySelectorAll('select[name="itemId"]')) {
    const selected = select.value;
    select.innerHTML = itemOptions(false);
    if ([...select.options].some(option => option.value === selected)) {
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
    <label>${itemLabel} <select name="itemId" required>${itemOptions(false)}</select></label>
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
document.getElementById('openItemDialog').addEventListener('click', () => document.getElementById('itemDialog').showModal());
document.getElementById('openReceiptDialog').addEventListener('click', () => document.getElementById('receiptDialog').showModal());
document.getElementById('openReceiptFromEntries').addEventListener('click', () => document.getElementById('receiptDialog').showModal());
document.getElementById('openCanonicalDialog').addEventListener('click', () => document.getElementById('itemDialog').showModal());
document.getElementById('closeItemDialog').addEventListener('click', () => document.getElementById('itemDialog').close());
document.getElementById('closeEditItemDialog').addEventListener('click', () => document.getElementById('editItemDialog').close());
document.getElementById('closeReceiptDialog').addEventListener('click', () => document.getElementById('receiptDialog').close());
document.getElementById('inventoryTab').addEventListener('click', async (e) => {
  const editButton = e.target.closest('button[data-edit-item-id]');
  if (editButton) {
    openEditItemDialog(Number(editButton.dataset.editItemId));
    return;
  }
  const button = e.target.closest('button[data-item-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await action(`/api/items/${button.dataset.itemId}/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: button.dataset.active !== 'true' })
    });
    await loadItems();
    await refreshInventory();
    await refreshAudit();
    await runWeeklyReport();
  } catch (err) {
    button.disabled = false;
    window.alert(err.message);
  }
});

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', async () => {
    document.querySelectorAll('.tab-button').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === button.dataset.tab));
    if (button.dataset.tab === 'auditTab') {
      await refreshAudit();
      await refreshAuditHistory();
    } else if (button.dataset.tab === 'entriesTab') {
      await refreshEntries();
    } else if (button.dataset.tab === 'analysisTab') {
      await refreshAnalysis();
    } else if (button.dataset.tab === 'skuTab') {
      await loadItems();
      renderSkuManagement();
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
  document.getElementById('itemDialog').close();
  await loadItems();
  renderAnalysisProducts();
  renderSkuManagement();
  await refreshInventory();
  await refreshAudit();
  await runWeeklyReport();
});

document.getElementById('editItemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  const id = Number(body.id);
  body.reorderLevel = Number(body.reorderLevel || 0);
  delete body.id;
  const status = document.getElementById('editItemStatus');
  status.textContent = 'Saving changes...';
  try {
    await action(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    document.getElementById('editItemDialog').close();
    await loadItems();
    renderAnalysisProducts();
    renderSkuManagement();
    await refreshInventory();
    await refreshAudit();
    await runWeeklyReport();
    await refreshEntries();
  } catch (err) {
    status.textContent = err.message;
  }
});

function openEditItemDialog(id) {
  const item = items.find(candidate => Number(candidate.id) === id);
  if (!item) return;
  const form = document.getElementById('editItemForm');
  form.elements.id.value = item.id;
  form.elements.name.value = item.name;
  form.elements.sku.value = item.sku || '';
  form.elements.reorderLevel.value = item.reorder_level || 0;
  document.getElementById('editItemStatus').textContent = '';
  document.getElementById('editItemDialog').showModal();
}

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
  document.getElementById('receiptDialog').close();
  await refreshInventory(); await refreshAudit();
});

document.getElementById('refresh').addEventListener('click', refreshInventory);
document.getElementById('runWeekly').addEventListener('click', runWeeklyReport);
document.getElementById('refreshEntries').addEventListener('click', refreshEntries);
document.getElementById('uploadEntries').addEventListener('click', uploadEntriesFile);
document.getElementById('refreshAnalysis').addEventListener('click', refreshAnalysis);
document.getElementById('analysisGranularity').addEventListener('change', renderAnalysis);
document.getElementById('analysisProducts').addEventListener('change', refreshAnalysis);
document.getElementById('selectAllAnalysis').addEventListener('click', () => setAnalysisProducts(true));
document.getElementById('clearAnalysis').addEventListener('click', () => setAnalysisProducts(false));
document.getElementById('mapSkus').addEventListener('click', mapSelectedSkus);
document.getElementById('skuManagementTable').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-unmap-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await action(`/api/items/${button.dataset.unmapId}/mapping`, { method: 'DELETE' });
    await loadItems();
    renderAnalysisProducts();
    renderSkuManagement('Mapping removed. The SKU is active again.');
    await refreshInventory();
  } catch (err) {
    renderSkuManagement(err.message);
  }
});
document.getElementById('printInventory').addEventListener('click', () => {
  const asOf = document.getElementById('asOf').value || today;
  const startDate = document.getElementById('inventoryStart').value || asOf;
  const endDate = document.getElementById('inventoryEnd').value || asOf;
  printReport('Calculated Inventory', `As of ${asOf} | Usage ${startDate} to ${endDate}`, 'inventoryList');
});
document.getElementById('printWeekly').addEventListener('click', () => {
  const startDate = document.getElementById('weekStart').value || today;
  const endDate = document.getElementById('weekEnd').value || today;
  printReport('Weekly Usage Report', `${startDate} to ${endDate}`, 'weeklyTable');
});
document.getElementById('printAudit').addEventListener('click', printAuditSheet);
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
  const params = new URLSearchParams({ asOf, startDate, endDate, includeInactive: 'true' });
  const rows = await action(`/api/inventory?${params}`);
  renderInventoryList(rows);
}

async function refreshEntries() {
  const entries = await action('/api/entries?limit=2000');
  renderTable('entriesTable', ['Date','Original SKU','Canonical SKU','QTY','Pulled By','Purpose','Notes'], entries.map(entry => [
    entry.date,
    entry.itemPulled,
    entry.canonicalItem || entry.itemPulled,
    entry.qty,
    entry.pulledBy || '',
    entry.purpose,
    entry.notes || ''
  ]));
}

function renderSkuManagement(message = '') {
  const sourceContainer = document.getElementById('skuMappingSources');
  const canonicalSelect = document.getElementById('canonicalSkuSelect');
  const sourceItems = items.filter(item => !Number(item.mappedItemCount));
  const canonicalItems = items.filter(item => !item.canonicalItemId);
  sourceContainer.innerHTML = sourceItems.map(item => `
    <label><input type="checkbox" value="${item.id}" /> <span>${escapeHtml(item.name)}${item.canonicalName ? ` → ${escapeHtml(item.canonicalName)}` : ''}</span></label>
  `).join('');
  canonicalSelect.innerHTML = `<option value="">Choose canonical SKU</option>` + canonicalItems
    .map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  renderTable('skuManagementTable', ['SKU','Code','Status','Mapped To','Starting QTY','Historical Received','Historical Used','Action'], items.map(item => [
    escapeHtml(item.name),
    escapeHtml(item.sku || ''),
    `<span class="status-badge${item.active ? ' active' : ''}">${item.canonicalItemId ? 'Legacy' : (item.active ? 'Active' : 'Inactive')}</span>`,
    escapeHtml(item.canonicalName || ''),
    Number(item.starting_quantity).toLocaleString(),
    Number(item.historicalReceived).toLocaleString(),
    Number(item.historicalUsed).toLocaleString(),
    item.canonicalItemId ? `<button type="button" class="secondary" data-unmap-id="${item.id}">Remove Mapping</button>` : ''
  ]), { allowHtml: true });
  document.getElementById('skuMappingStatus').textContent = message;
}

async function mapSelectedSkus() {
  const sourceIds = [...document.querySelectorAll('#skuMappingSources input:checked')].map(input => Number(input.value));
  const canonicalId = Number(document.getElementById('canonicalSkuSelect').value);
  const status = document.getElementById('skuMappingStatus');
  if (!sourceIds.length || !canonicalId) {
    status.textContent = 'Select at least one source SKU and a canonical SKU.';
    return;
  }
  const canonical = items.find(item => Number(item.id) === canonicalId);
  const sources = items.filter(item => sourceIds.includes(Number(item.id)));
  const summary = sources.map(item => `${item.name} (starting ${item.starting_quantity}, received ${item.historicalReceived}, used ${item.historicalUsed})`).join('\n');
  if (!window.confirm(`Map these SKUs to ${canonical.name}?\n\n${summary}\n\nHistorical transactions will keep their original SKU.`)) return;
  status.textContent = 'Saving mapping...';
  try {
    await postJson('/api/items/map', { sourceIds, canonicalId });
    await loadItems();
    renderAnalysisProducts();
    renderSkuManagement(`${sources.length} SKU${sources.length === 1 ? '' : 's'} mapped to ${canonical.name}.`);
    await refreshInventory();
    await refreshAudit();
    await runWeeklyReport();
  } catch (err) {
    status.textContent = err.message;
  }
}

function renderAnalysisProducts() {
  const container = document.getElementById('analysisProducts');
  container.innerHTML = items.filter(item => !item.canonicalItemId).map(item => `
    <label><input type="checkbox" value="${item.id}" checked />
      <span>${escapeHtml(item.name)}${item.active ? '' : ' (inactive)'}</span>
    </label>
  `).join('');
}

function setAnalysisProducts(checked) {
  document.querySelectorAll('#analysisProducts input').forEach(input => { input.checked = checked; });
  refreshAnalysis();
}

function selectedAnalysisItems() {
  return [...document.querySelectorAll('#analysisProducts input:checked')].map(input => Number(input.value));
}

async function refreshAnalysis() {
  const selectedIds = selectedAnalysisItems();
  const status = document.getElementById('analysisStatus');
  if (!selectedIds.length) {
    analysisRows = [];
    status.textContent = 'Select at least one product to view usage.';
    renderAnalysis();
    return;
  }
  status.textContent = 'Loading usage...';
  try {
    const params = new URLSearchParams({ itemIds: selectedIds.join(',') });
    const result = await action(`/api/reports/usage-analysis?${params}`);
    analysisRows = result.rows;
    status.textContent = analysisRows.length ? '' : 'No usage has been recorded for the selected products.';
    renderAnalysis();
  } catch (err) {
    status.textContent = err.message;
  }
}

function parseUsageDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function periodStart(date, granularity) {
  const result = new Date(date);
  if (granularity === 'week') {
    const day = result.getUTCDay();
    result.setUTCDate(result.getUTCDate() - (day === 0 ? 6 : day - 1));
  } else if (granularity === 'month') {
    result.setUTCDate(1);
  } else {
    result.setUTCMonth(Math.floor(result.getUTCMonth() / 3) * 3, 1);
  }
  return result;
}

function nextPeriod(date, granularity) {
  const result = new Date(date);
  if (granularity === 'week') result.setUTCDate(result.getUTCDate() + 7);
  if (granularity === 'month') result.setUTCMonth(result.getUTCMonth() + 1);
  if (granularity === 'quarter') result.setUTCMonth(result.getUTCMonth() + 3);
  return result;
}

function periodCount(firstDate, lastDate, granularity) {
  let cursor = periodStart(firstDate, granularity);
  const end = periodStart(lastDate, granularity);
  let count = 0;
  while (cursor <= end) {
    count += 1;
    cursor = nextPeriod(cursor, granularity);
  }
  return count;
}

function monthKey(value) {
  return value.slice(0, 7);
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function renderAnalysis() {
  const total = analysisRows.reduce((sum, row) => sum + Number(row.qty), 0);
  const granularity = document.getElementById('analysisGranularity').value;
  const dates = analysisRows.map(row => row.date).sort();
  const periods = dates.length
    ? periodCount(parseUsageDate(dates[0]), parseUsageDate(dates[dates.length - 1]), granularity)
    : 0;
  document.getElementById('analysisTotal').textContent = total.toLocaleString();
  document.getElementById('analysisAverageLabel').textContent = `Average per ${granularity}`;
  document.getElementById('analysisAverage').textContent = periods ? (total / periods).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '0';
  document.getElementById('analysisRange').textContent = dates.length ? `${dates[0]} – ${dates[dates.length - 1]}` : 'No usage';

  const selectedIds = new Set(selectedAnalysisItems());
  const selectedItems = items.filter(item => selectedIds.has(Number(item.id)));
  if (!dates.length) {
    renderTable('analysisMonthlyTable', ['Month', ...selectedItems.map(item => item.name), 'Total'], []);
    return;
  }

  const firstMonth = periodStart(parseUsageDate(dates[0]), 'month');
  const lastMonth = periodStart(parseUsageDate(dates[dates.length - 1]), 'month');
  const monthly = new Map();
  for (const row of analysisRows) {
    const key = monthKey(row.date);
    if (!monthly.has(key)) monthly.set(key, new Map());
    const itemTotals = monthly.get(key);
    itemTotals.set(Number(row.itemId), (itemTotals.get(Number(row.itemId)) || 0) + Number(row.qty));
  }
  const tableRows = [];
  for (let cursor = firstMonth; cursor <= lastMonth; cursor = nextPeriod(cursor, 'month')) {
    const key = cursor.toISOString().slice(0, 7);
    const itemTotals = monthly.get(key) || new Map();
    const quantities = selectedItems.map(item => itemTotals.get(Number(item.id)) || 0);
    tableRows.push([monthLabel(key), ...quantities, quantities.reduce((sum, qty) => sum + qty, 0)]);
  }
  renderTable('analysisMonthlyTable', ['Month', ...selectedItems.map(item => item.name), 'Total'], tableRows);
}

async function uploadEntriesFile() {
  const input = document.getElementById('entriesUpload');
  const status = document.getElementById('entriesUploadStatus');
  const file = input.files[0];
  if (!file) {
    status.textContent = 'Choose a report .xlsx file first.';
    return;
  }
  status.textContent = 'Reading report...';
  try {
    const result = await action('/api/entries/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'X-File-Name': file.name
      },
      body: await file.arrayBuffer()
    });
    const dateRange = result.startDate && result.endDate
      ? ` Date range: ${result.startDate} to ${result.endDate}.`
      : '';
    status.textContent = `Inserted ${result.inserted} new entries. Skipped ${result.skipped} duplicates.${dateRange}`;
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
  renderTable('auditDetailTable', ['Original SKU','Canonical SKU','Counted Number'], audit.rows.map(row => [
    row.item,
    row.canonicalItem || row.item,
    row.countedQty
  ]));
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
          a { display: inline-block; margin-bottom: 10px; color: #1d4ed8; font-weight: 700; text-decoration: none; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          p { margin: 0 0 18px; color: #555; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border-bottom: 1px solid #ccc; padding: 7px; text-align: left; }
          th { background: #f0f2f5; }
          .inventory-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
          .inventory-item { border: 1px solid #ccc; padding: 10px; break-inside: avoid; }
          .inventory-item h3 { margin: 0 0 8px; font-size: 14px; }
          .inventory-item dl { display: grid; gap: 5px; margin: 0; }
          .inventory-item dl div { display: flex; justify-content: space-between; gap: 8px; }
          .inventory-item dt { color: #555; }
          .inventory-item dd { margin: 0; font-weight: 700; }
          .item-status-button { display: none; }
        </style>
      </head>
      <body>
        <a href="https://manufacturing-tracker.onrender.com" target="_blank" rel="noopener">Manufacturing Tracker</a>
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

function printAuditSheet() {
  const countedDate = document.getElementById('auditDate').value || today;
  const countedBy = document.querySelector('#auditForm input[name="countedBy"]').value.trim();
  const notes = document.querySelector('#auditForm input[name="notes"]').value.trim();
  const rows = [...document.querySelectorAll('#auditTable tbody tr')].map(row => {
    const cells = row.querySelectorAll('td');
    return {
      item: cells[0]?.textContent.trim() || '',
      knownCount: cells[1]?.textContent.trim() || '',
      lastAudit: cells[2]?.textContent.trim() || ''
    };
  });
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) return;
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>Inventory Audit Count Sheet</title>
        <style>
          body { font-family: Arial, sans-serif; color: #222; margin: 24px; }
          a { display: inline-block; margin-bottom: 10px; color: #1d4ed8; font-weight: 700; text-decoration: none; }
          h1 { margin: 0 0 6px; font-size: 22px; }
          p { margin: 0 0 18px; color: #555; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #bbb; padding: 8px; text-align: left; vertical-align: middle; }
          th { background: #f0f2f5; }
          tr { break-inside: avoid; }
          .count-space { height: 28px; border-bottom: 2px solid #222; min-width: 120px; }
          .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; margin: 0 0 18px; }
          .meta div { border-bottom: 1px solid #999; padding-bottom: 6px; min-height: 20px; }
          .meta span { color: #555; font-size: 12px; font-weight: 700; text-transform: uppercase; }
        </style>
      </head>
      <body>
        <a href="https://manufacturing-tracker.onrender.com" target="_blank" rel="noopener">Manufacturing Tracker</a>
        <h1>Inventory Audit Count Sheet</h1>
        <p>Audit date: ${escapeHtml(countedDate)}</p>
        <div class="meta">
          <div><span>Counted By</span><br>${escapeHtml(countedBy)}</div>
          <div><span>Notes</span><br>${escapeHtml(notes)}</div>
        </div>
        <table>
          <thead><tr><th>Item</th><th>Known Count</th><th>Last Audit</th><th>Physical Count</th></tr></thead>
          <tbody>${rows.map(row => `
            <tr>
              <td>${escapeHtml(row.item)}</td>
              <td>${escapeHtml(row.knownCount)}</td>
              <td>${escapeHtml(row.lastAudit)}</td>
              <td><div class="count-space"></div></td>
            </tr>
          `).join('')}</tbody>
        </table>
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

function renderInventoryList(rows) {
  const list = document.getElementById('inventoryList');
  const inactiveList = document.getElementById('inactiveInventoryList');
  const inactiveSection = document.getElementById('inactiveInventorySection');
  const renderCards = inventoryRows => inventoryRows.map(row => `
    <article class="inventory-item${row.active ? '' : ' inactive'}">
      <div class="inventory-item-header">
        <h3>${escapeHtml(row.name)}${row.componentCount > 1 ? ` <span class="status-badge">${row.componentCount} SKUs</span>` : ''}</h3>
        <div class="inventory-item-actions">
          <button type="button" class="secondary item-status-button" data-edit-item-id="${row.id}">Edit</button>
          <button type="button" class="secondary item-status-button" data-item-id="${row.id}" data-active="${Boolean(row.active)}">
            ${row.active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
      <dl>
        <div><dt>SKU</dt><dd>${escapeHtml(row.sku || '—')}</dd></div>
        <div><dt>Reorder Level</dt><dd>${row.reorderLevel}</dd></div>
        <div><dt>Starting</dt><dd>${row.startingQuantity}</dd></div>
        <div><dt>Received</dt><dd>${row.totalReceived}</dd></div>
        <div><dt>Pulled</dt><dd>${row.totalPulled}</dd></div>
        <div><dt>Used In Range</dt><dd>${row.pulledInRange}</dd></div>
        <div><dt>On Hand</dt><dd>${row.calculatedOnHand}</dd></div>
      </dl>
    </article>
  `).join('');
  const activeRows = rows.filter(row => row.active);
  const inactiveRows = rows.filter(row => !row.active);
  list.innerHTML = renderCards(activeRows);
  inactiveList.innerHTML = renderCards(inactiveRows);
  inactiveSection.hidden = inactiveRows.length === 0;
}
