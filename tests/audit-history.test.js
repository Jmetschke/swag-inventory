const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('audit history snapshots totals and distinguishes recoverable and unknown historical counts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-history-'));
  process.env.TURSO_DATABASE_URL = `file:${path.join(directory, 'test.sqlite')}`;
  process.env.TURSO_DATABASE_TOKEN = 'test';
  const { db, initDb, all, run } = require('../server/src/db');
  const q = require('../server/src/queries');
  try {
    await initDb();
    await initDb(); // Migration can run again on subsequent server starts.
    const first = (await q.createItem({ name: 'History A', startingQuantity: 11 })).lastInsertRowid;
    const second = (await q.createItem({ name: 'History B', startingQuantity: 4 })).lastInsertRowid;
    const { auditId } = await q.createAudit({ counts: [{ itemId: first, countedQty: 5 }, { itemId: second, countedQty: 7 }], countedDate: '2026-11-11', countedBy: 'Jane' });
    const summary = (await q.listAudits()).find(row => row.id === auditId);
    assert.equal(summary.startingTotal, 15);
    assert.equal(summary.endingTotal, 12);
    assert.equal(summary.removedQty, 6);
    assert.equal(summary.addedQty, 3);
    assert.equal(summary.netChange, -3);
    assert.equal(summary.itemCount, 2);
    const details = await q.getAuditDetails(auditId);
    assert.equal(details[0].startingQty, 11);
    assert.equal(details[1].startingQty, 4);
    assert.equal(details[0].startingSource, 'recorded');
    await q.createAudit({ counts: [{ itemId: first, countedQty: 2 }], countedDate: '2026-11-12' });
    assert.deepEqual((await q.listAudits()).find(row => row.id === auditId), summary);
    // Simulate older audit data that did not store starting counts.
    await run('UPDATE audit_items SET starting_qty = NULL WHERE audit_id = ?', [auditId]);
    const historical = await q.getAuditDetails(auditId);
    assert.equal(historical[0].startingQty, 11);
    assert.equal(historical[0].startingSource, 'recovered');
    assert.equal(historical[1].startingQty, null);
    const oldSummary = (await q.listAudits()).find(row => row.id === auditId);
    assert.equal(oldSummary.endingTotal, 12);
    assert.equal(oldSummary.startingTotal, null);
    assert.equal(oldSummary.removedQty, null);
    assert.equal(oldSummary.netChange, null);
    assert.equal(oldSummary.missingStartingCounts, 1);
    const legacyId = (await run("INSERT INTO audit_sessions(counted_date) VALUES ('2026-10-01')")).lastInsertRowid;
    await run('INSERT INTO audit_items(audit_id, item_id, counted_qty) VALUES (?, ?, ?)', [legacyId, first, 8]);
    const legacy = (await q.listAudits()).find(row => row.id === legacyId);
    assert.equal(legacy.endingTotal, 8);
    assert.equal(legacy.startingTotal, null);
    assert.equal((await q.listAudits())[0].countedDate, '2026-11-12');
    assert.equal((await all('SELECT COUNT(*) AS n FROM inventory_pulls'))[0].n, 2);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
