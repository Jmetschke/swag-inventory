const path = require("path");
const zlib = require("zlib");

const XML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'"
};

function decodeXml(value = "") {
  return value.replace(/&([^;]+);/g, (_, entity) => {
    if (XML_ENTITIES[entity]) return XML_ENTITIES[entity];
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return `&${entity};`;
  });
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Invalid XLSX file");
}

function unzipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const centralDirSize = buffer.readUInt32LE(eocd + 12);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = centralDirOffset;
  const end = centralDirOffset + centralDirSize;

  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid XLSX local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = compression === 0 ? compressed : zlib.inflateRawSync(compressed);
    entries.set(name, data.toString("utf8"));

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map(match => {
    const textParts = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)];
    return decodeXml(textParts.map(part => part[1]).join(""));
  });
}

function parseRelationships(xml) {
  const rels = new Map();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = parseAttributes(match[1]);
    rels.set(attrs.Id, attrs.Target);
  }
  return rels;
}

function parseAttributes(text) {
  const attrs = {};
  for (const match of text.matchAll(/([A-Za-z_:]+)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseWorkbookSheets(workbookXml, relsXml) {
  const rels = parseRelationships(relsXml);
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)].map(match => {
    const attrs = parseAttributes(match[1]);
    const relId = attrs["r:id"];
    const target = rels.get(relId);
    const filePath = target.startsWith("/")
      ? target.slice(1)
      : target.startsWith("xl/")
        ? target
        : path.posix.join("xl", target);
    return { name: attrs.name, path: filePath };
  });
}

function columnName(ref) {
  return ref.replace(/[0-9]/g, "");
}

function excelDate(serial) {
  if (typeof serial === "string" && /^\d{4}-\d{2}-\d{2}/.test(serial.trim())) {
    return serial.trim().slice(0, 10);
  }
  if (typeof serial === "string" && /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(serial.trim())) {
    const [month, day, year] = serial.trim().split("/").map(Number);
    const fullYear = year < 100 ? 2000 + year : year;
    return new Date(Date.UTC(fullYear, month - 1, day)).toISOString().slice(0, 10);
  }
  const date = new Date(Date.UTC(1899, 11, 30));
  date.setUTCDate(date.getUTCDate() + Number(serial));
  return date.toISOString().slice(0, 10);
}

function cellValue(cellXml, sharedStrings) {
  const attrs = parseAttributes(cellXml.match(/<c\b([^>]*)>/)?.[1] || "");
  const inline = cellXml.match(/<is\b[\s\S]*?<\/is>/);
  if (attrs.t === "inlineStr" && inline) {
    return decodeXml([...inline[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(""));
  }
  const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (value === undefined) return "";
  if (attrs.t === "s") return sharedStrings[Number(value)] || "";
  return decodeXml(value);
}

function parseReportingRows(sheetXml, sharedStrings, fileName) {
  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const rowNumber = Number(rowAttrs.r);
    if (!rowNumber || rowNumber === 1) continue;

    const values = {};
    for (const cellMatch of rowMatch[2].matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const ref = cellMatch[0].match(/r="([^"]+)"/)?.[1];
      if (!ref) continue;
      values[columnName(ref)] = cellValue(cellMatch[0], sharedStrings);
    }

    if (!values.B || !values.C) continue;
    const qty = Number(values.C);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    rows.push({
      sourceRef: `${fileName}:reporting sheet:${rowNumber}`,
      sourceRow: rowNumber,
      pulledDate: excelDate(values.A),
      item: values.B,
      qty,
      pulledBy: values.D || "",
      purpose: values.E || "Other",
      notes: values.F || ""
    });
  }
  return rows;
}

function parseReportingWorkbook(buffer, fileName = "uploaded.xlsx") {
  const entries = unzipEntries(Buffer.from(buffer));
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));
  const sheets = parseWorkbookSheets(entries.get("xl/workbook.xml"), entries.get("xl/_rels/workbook.xml.rels"));
  const reportingSheet = sheets.find(sheet => sheet.name.toLowerCase() === "reporting sheet") || sheets[0];
  if (!reportingSheet) throw new Error("No worksheet found in uploaded file");
  const sheetXml = entries.get(reportingSheet.path);
  if (!sheetXml) throw new Error("Could not read reporting sheet from uploaded file");
  return parseReportingRows(sheetXml, sharedStrings, fileName);
}

module.exports = { parseReportingWorkbook };
