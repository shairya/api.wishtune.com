/**
 * lib/tabular.js — reads a CSV or Excel (.xlsx) file into header + row objects.
 * No dependencies: CSV per RFC 4180; .xlsx is unzipped with Node's zlib and
 * the first worksheet's XML is read directly (values only, no formulas).
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* ------------------------------- CSV ------------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

/* ------------------------------- XLSX ------------------------------ */

function unzip(buf) {
  // End of central directory record (search from the end).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (zip directory not found)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlDecode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml) => xmlDecode((xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));

function colIndex(ref) {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buf) {
  const files = unzip(buf);
  const shared = files["xl/sharedStrings.xml"]
    ? (files["xl/sharedStrings.xml"]().match(/<si>[\s\S]*?<\/si>/g) || []).map(textOf)
    : [];

  // First sheet in workbook order.
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (files["xl/workbook.xml"] && files["xl/_rels/workbook.xml.rels"]) {
    const first = files["xl/workbook.xml"]().match(/<sheet\b[^>]*r:id="([^"]+)"/);
    const rels = files["xl/_rels/workbook.xml.rels"]();
    const target = first && rels.match(new RegExp(`Id="${first[1]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${first[1]}"`));
    const t = target && (target[1] || target[2]);
    if (t) sheetPath = t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`;
  }
  if (!files[sheetPath]) throw new Error("No worksheet found in the .xlsx file");

  const rows = [];
  for (const rowXml of files[sheetPath]().match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const row = [];
    for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const inner = m[2] || "";
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "b") value = v === "1" ? "1" : "0";
      else value = v !== undefined ? xmlDecode(v) : "";
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? "" : x)));
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

/* ----------------------------- public ------------------------------ */

/** @returns {{ headers: string[], rows: Record<string,string>[] }} keys are the original header names */
function readTable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  let grid;
  if (ext === ".xlsx") grid = parseXlsx(buf);
  else if (ext === ".csv" || ext === ".txt") grid = parseCsv(buf.toString("utf8"));
  else if (ext === ".xls") throw new Error("Old .xls files are not supported — save as .xlsx or .csv");
  else throw new Error(`Unsupported file type "${ext}" — use .csv or .xlsx`);
  if (!grid.length) throw new Error("The file is empty");
  const headers = grid[0].map((h) => String(h).trim());
  const rows = grid.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] === undefined ? "" : String(r[i])])));
  return { headers, rows };
}

/** Excel stores dates as serial numbers (days since 1899-12-30). */
function excelSerialToISODate(n) {
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

module.exports = { readTable, parseCsv, parseXlsx, excelSerialToISODate };
