function getWeekStart(dateString) {
  const d = new Date(`${dateString}T00:00:00`);
  const day = d.getDay(); // Sunday 0, Monday 1
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getWeekEnd(dateString) {
  return addDays(getWeekStart(dateString), 6);
}

function buildWeekColumns(startDate, count = 44) {
  // Spreadsheet equivalent: B2 = starting week, C2 = B2 + 7, etc.
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(startDate, index * 7);
    return { weekNumber: index + 1, startDate: start, endDate: addDays(start, 6) };
  });
}

function summarizeRows(rows, groupKeys, valueKey = "qty") {
  const output = new Map();
  for (const row of rows) {
    const key = groupKeys.map(k => row[k] ?? "").join("||");
    output.set(key, (output.get(key) || 0) + Number(row[valueKey] || 0));
  }
  return output;
}

module.exports = { getWeekStart, getWeekEnd, addDays, buildWeekColumns, summarizeRows };
