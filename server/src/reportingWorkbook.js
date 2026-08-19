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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(contents);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function encodeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createEntryTemplate(activeItems = []) {
  const referenceRows = activeItems.map((item, index) =>
    `<row r="${index + 2}"><c r="G${index + 2}" t="inlineStr"><is><t>${encodeXml(item.name)}</t></is></c></row>`
  ).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Reporting Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="3" width="10" customWidth="1"/><col min="4" max="4" width="20" customWidth="1"/><col min="5" max="5" width="20" customWidth="1"/><col min="6" max="6" width="36" customWidth="1"/><col min="7" max="7" width="32" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr" s="1"><is><t>Date</t></is></c><c r="B1" t="inlineStr" s="1"><is><t>Item Pulled</t></is></c><c r="C1" t="inlineStr" s="1"><is><t>QTY</t></is></c><c r="D1" t="inlineStr" s="1"><is><t>Pulled By</t></is></c><c r="E1" t="inlineStr" s="1"><is><t>Purpose</t></is></c><c r="F1" t="inlineStr" s="1"><is><t>Notes</t></is></c><c r="G1" t="inlineStr" s="1"><is><t>Active Items (Reference)</t></is></c></row>${referenceRows}</sheetData><autoFilter ref="A1:F1000"/><dataValidations count="3"><dataValidation type="date" allowBlank="0" showErrorMessage="1" errorTitle="Invalid date" error="Enter a valid date." sqref="A2:A1000"><formula1>DATE(2000,1,1)</formula1><formula2>DATE(2100,12,31)</formula2></dataValidation><dataValidation type="whole" operator="greaterThan" allowBlank="0" showErrorMessage="1" errorTitle="Invalid quantity" error="Enter a whole number greater than zero." sqref="C2:C1000"><formula1>0</formula1></dataValidation><dataValidation type="list" allowBlank="0" showErrorMessage="1" errorTitle="Invalid purpose" error="Choose a purpose from the list." sqref="E2:E1000"><formula1>&quot;Delivery/Client,Event/Promo,Employee,Other&quot;</formula1></dataValidation></dataValidations></worksheet>`
  };
  return createZip(files);
}

module.exports = { parseReportingWorkbook, createEntryTemplate };
