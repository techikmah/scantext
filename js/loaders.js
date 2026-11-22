// File intake: decide what a file is, then turn it into something the viewer can show.
//
//   PDF                      → handled in app.js with pdf.js (text layer or OCR per page)
//   images, TIFF             → decoded to canvases here, OCR'd by app.js
//   DOCX PPTX XLSX ODT ODS ODP CSV TSV TXT MD JSON XML HTML RTF
//                            → parsed here, entirely in the browser, into "text pages"
//
// A text page is {kind:"text", title, blocks, text}. A block is one of
//   {t:"h", level, text} {t:"p", text} {t:"code", text} {t:"table", rows:[[cell…]…]}
// and `text` is the plain-text form used for search, translation and export. Nothing
// here uploads anything.

import { unzipSync, strFromU8 } from "../lib/fflate/fflate.min.js";
import { parseDelimited, sniffDelimiter } from "./text-utils.js";

export const ACCEPT = [
  ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff",
  ".docx", ".pptx", ".xlsx", ".odt", ".ods", ".odp",
  ".csv", ".tsv", ".txt", ".md", ".markdown", ".log", ".json", ".xml", ".html", ".htm", ".rtf",
].join(",");

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
const PAGE_CHARS = 3200; // soft size of one text page
const TABLE_ROWS_PER_PAGE = 400;
const MAX_SHEET_ROWS = 20000;
const MAX_SHEET_COLS = 120;

// ---------- classification ----------

const BY_EXT = {
  pdf: ["pdf", "PDF"],
  png: ["image", "Image"], jpg: ["image", "Photo"], jpeg: ["image", "Photo"], webp: ["image", "Image"],
  gif: ["image", "Image"], bmp: ["image", "Image"], avif: ["image", "Image"],
  tif: ["tiff", "TIFF scan"], tiff: ["tiff", "TIFF scan"],
  docx: ["docx", "Word document"], pptx: ["pptx", "PowerPoint"], xlsx: ["xlsx", "Excel workbook"],
  odt: ["odf", "OpenDocument text"], ods: ["odf", "OpenDocument sheet"], odp: ["odf", "OpenDocument slides"],
  csv: ["csv", "CSV table"], tsv: ["csv", "TSV table"],
  txt: ["text", "Text file"], md: ["text", "Markdown"], markdown: ["text", "Markdown"], log: ["text", "Log file"],
  json: ["json", "JSON"], xml: ["xml", "XML"], html: ["html", "HTML page"], htm: ["html", "HTML page"],
  rtf: ["rtf", "Rich text"],
  doc: ["legacy", "Word 97-2003"], xls: ["legacy", "Excel 97-2003"], ppt: ["legacy", "PowerPoint 97-2003"],
  heic: ["heic", "HEIC photo"], heif: ["heic", "HEIC photo"],
};

const LEGACY_HINT = {
  doc: "Old .doc files can't be read in the browser. Save it as .docx (or PDF) in Word or LibreOffice and open that.",
  xls: "Old .xls files can't be read in the browser. Save it as .xlsx or .csv and open that.",
  ppt: "Old .ppt files can't be read in the browser. Save it as .pptx (or PDF) and open that.",
};

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function classify(file) {
  const ext = extensionOf(file.name);
  if (BY_EXT[ext]) {
    const [kind, label] = BY_EXT[ext];
    return { kind, label, ext };
  }
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf") return { kind: "pdf", label: "PDF", ext: "pdf" };
  if (type.startsWith("image/")) {
    if (type === "image/tiff") return { kind: "tiff", label: "TIFF scan", ext: "tiff" };
    if (type === "image/heic" || type === "image/heif") return { kind: "heic", label: "HEIC photo", ext: "heic" };
    return { kind: "image", label: "Image", ext: "png" };
  }
  if (type.startsWith("text/")) return { kind: "text", label: "Text file", ext: "txt" };
  return { kind: "unknown", label: "Unknown", ext };
}

export function unsupportedMessage(file, info) {
  if (info.kind === "legacy") return LEGACY_HINT[info.ext] || "That legacy format can't be read in the browser. Save it as a modern format and open that.";
  if (info.kind === "heic") return "HEIC photos can't be decoded by most browsers. Export the photo as JPG or PNG and open that.";
  return `ScanText can't open ".${info.ext || "?"}" files. It reads PDF, images, TIFF, Word, PowerPoint, Excel, OpenDocument, CSV, text, HTML and RTF.`;
}

export const isVisualKind = (kind) => kind === "pdf" || kind === "image" || kind === "tiff";

// ---------- small XML helpers (work with browser DOMParser and linkedom) ----------

function parseXml(str) {
  const doc = new DOMParser().parseFromString(str, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("This file's XML is damaged.");
  return doc;
}

const nm = (el) => String((el && (el.localName || el.nodeName)) || "").split(":").pop();
const elementChildren = (el) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1);

function attr(el, local) {
  if (!el || !el.attributes) return null;
  for (const a of Array.from(el.attributes)) {
    if (String(a.name).split(":").pop() === local) return a.value;
  }
  return null;
}

function* walk(el, skip) {
  for (const child of elementChildren(el)) {
    if (skip && skip(child)) continue;
    yield child;
    yield* walk(child, skip);
  }
}

function findAll(el, name) {
  const out = [];
  for (const n of walk(el)) if (nm(n) === name) out.push(n);
  return out;
}

function findFirst(el, name) {
  for (const n of walk(el)) if (nm(n) === name) return n;
  return null;
}

function readEntry(files, path) {
  const data = files[path];
  return data ? strFromU8(data) : null;
}

function unzip(bytes) {
  try {
    return unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error("Couldn't open this file — it isn't a valid Office/OpenDocument archive, or it's damaged or password-protected.");
  }
}

// ---------- block → text, pagination ----------

export function blocksToText(blocks) {
  return blocks
    .map((b) => (b.t === "table" ? b.rows.map((r) => r.join("\t")).join("\n") : b.text))
    .filter((s) => s && s.length)
    .join("\n");
}

function makePage(blocks, title = null) {
  return { kind: "text", title, blocks, text: blocksToText(blocks) };
}

function blockSize(b) {
  return b.t === "table" ? b.rows.reduce((n, r) => n + r.join(" ").length, 0) : (b.text || "").length;
}

// Splits a flat run of blocks into pages of roughly PAGE_CHARS characters, never
// mid-block (but tables are first cut into slices so a huge one can break).
export function paginateBlocks(blocks) {
  const flat = [];
  for (const b of blocks) {
    if (b.t === "table" && b.rows.length > TABLE_ROWS_PER_PAGE) {
      for (let i = 0; i < b.rows.length; i += TABLE_ROWS_PER_PAGE) {
        flat.push({ t: "table", rows: b.rows.slice(i, i + TABLE_ROWS_PER_PAGE) });
      }
    } else flat.push(b);
  }
  const pages = [];
  let cur = [];
  let size = 0;
  for (const b of flat) {
    const s = blockSize(b);
    if (cur.length && size + s > PAGE_CHARS) {
      pages.push(makePage(cur));
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += s;
  }
  if (cur.length) pages.push(makePage(cur));
  return pages;
}

function tablePages(rows, titleBase) {
  const out = [];
  const clean = trimGrid(rows);
  if (!clean.length) return [makePage([{ t: "p", text: "(This sheet is empty.)" }], titleBase)];
  for (let i = 0; i < clean.length; i += TABLE_ROWS_PER_PAGE) {
    const slice = clean.slice(i, i + TABLE_ROWS_PER_PAGE);
    const range = clean.length > TABLE_ROWS_PER_PAGE ? ` (rows ${i + 1}–${i + slice.length})` : "";
    out.push(makePage([{ t: "table", rows: slice }], `${titleBase}${range}`));
  }
  return out;
}

function trimGrid(rows) {
  let lastRow = rows.length - 1;
  const isEmptyRow = (r) => !r || r.every((c) => c === "" || c == null);
  while (lastRow >= 0 && isEmptyRow(rows[lastRow])) lastRow--;
  const kept = rows.slice(0, lastRow + 1);
  let width = 0;
  for (const r of kept) {
    let w = r.length;
    while (w > 0 && (r[w - 1] === "" || r[w - 1] == null)) w--;
    if (w > width) width = w;
  }
  return kept.map((r) => {
    const row = r.slice(0, width).map((c) => (c == null ? "" : String(c)));
    while (row.length < width) row.push("");
    return row;
  });
}

// ---------- DOCX ----------

function docxParagraphText(p) {
  let out = "";
  const skip = (n) => nm(n) === "Fallback"; // mc:AlternateContent repeats text boxes in Fallback
  for (const n of walk(p, skip)) {
    const name = nm(n);
    if (name === "t") out += n.textContent;
    else if (name === "tab") out += "\t";
    else if (name === "br" || name === "cr") out += "\n";
    else if (name === "noBreakHyphen") out += "-";
  }
  return out;
}

function docxHeadingLevel(p) {
  const pPr = elementChildren(p).find((c) => nm(c) === "pPr");
  if (!pPr) return 0;
  const style = elementChildren(pPr).find((c) => nm(c) === "pStyle");
  const val = style ? attr(style, "val") || "" : "";
  if (/^title$/i.test(val)) return 1;
  const m = /^heading\s*(\d)$/i.exec(val);
  if (m) return Math.min(3, Number(m[1]));
  const outline = elementChildren(pPr).find((c) => nm(c) === "outlineLvl");
  if (outline) return Math.min(3, Number(attr(outline, "val")) + 1 || 1);
  return 0;
}

function docxIsListItem(p) {
  const pPr = elementChildren(p).find((c) => nm(c) === "pPr");
  if (!pPr) return false;
  if (elementChildren(pPr).some((c) => nm(c) === "numPr")) return true;
  // Word's built-in list styles carry the numbering in the style, not the paragraph.
  const style = elementChildren(pPr).find((c) => nm(c) === "pStyle");
  return !!style && /^List(Bullet|Number|Paragraph|Continue)?\d*$/i.test(attr(style, "val") || "");
}

function docxBlocks(container, out) {
  for (const el of elementChildren(container)) {
    const name = nm(el);
    if (name === "p") {
      const text = docxParagraphText(el).replace(/[ \t]+$/g, "");
      if (!text.trim()) continue;
      const level = docxHeadingLevel(el);
      if (level) out.push({ t: "h", level, text: text.trim() });
      else out.push({ t: "p", text: docxIsListItem(el) ? `• ${text.trim()}` : text });
    } else if (name === "tbl") {
      const rows = [];
      for (const tr of elementChildren(el).filter((c) => nm(c) === "tr")) {
        const cells = [];
        for (const tc of elementChildren(tr).filter((c) => nm(c) === "tc")) {
          const parts = findAll(tc, "p").map((p) => docxParagraphText(p).trim()).filter(Boolean);
          cells.push(parts.join(" "));
        }
        rows.push(cells);
      }
      const clean = trimGrid(rows);
      if (clean.length) out.push({ t: "table", rows: clean });
    } else if (name === "sdt" || name === "sdtContent" || name === "customXml" || name === "ins" || name === "smartTag") {
      docxBlocks(el, out);
    }
  }
}

export function parseDocx(bytes) {
  const files = unzip(bytes);
  const main = readEntry(files, "word/document.xml");
  if (!main) throw new Error("This doesn't look like a Word (.docx) file.");
  const doc = parseXml(main);
  const body = findFirst(doc.documentElement, "body");
  const blocks = [];
  if (body) docxBlocks(body, blocks);
  const pages = paginateBlocks(blocks);
  return pages.length ? pages : [makePage([{ t: "p", text: "(This document has no text.)" }])];
}

// ---------- PPTX ----------

function relsMap(xmlStr) {
  const map = {};
  if (!xmlStr) return map;
  for (const r of findAll(parseXml(xmlStr).documentElement, "Relationship")) {
    map[attr(r, "Id")] = attr(r, "Target");
  }
  return map;
}

function resolvePath(baseDir, target) {
  if (!target) return "";
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function drawingParagraphText(p) {
  let out = "";
  for (const n of walk(p)) {
    const name = nm(n);
    if (name === "t") out += n.textContent;
    else if (name === "br") out += "\n";
  }
  return out;
}

function pptxShapeBlocks(container, out) {
  for (const el of elementChildren(container)) {
    const name = nm(el);
    if (name === "sp") {
      const ph = findFirst(el, "ph");
      const phType = ph ? attr(ph, "type") || "body" : null;
      const txBody = elementChildren(el).find((c) => nm(c) === "txBody");
      if (!txBody) continue;
      for (const p of elementChildren(txBody).filter((c) => nm(c) === "p")) {
        const text = drawingParagraphText(p).trim();
        if (!text) continue;
        if (phType === "title" || phType === "ctrTitle") out.push({ t: "h", level: 1, text });
        else out.push({ t: "p", text });
      }
    } else if (name === "graphicFrame") {
      const tbl = findFirst(el, "tbl");
      if (tbl) {
        const rows = elementChildren(tbl)
          .filter((c) => nm(c) === "tr")
          .map((tr) =>
            elementChildren(tr)
              .filter((c) => nm(c) === "tc")
              .map((tc) => findAll(tc, "p").map((p) => drawingParagraphText(p).trim()).filter(Boolean).join(" "))
          );
        const clean = trimGrid(rows);
        if (clean.length) out.push({ t: "table", rows: clean });
      }
    } else if (name === "grpSp") {
      pptxShapeBlocks(el, out);
    }
  }
}

export function parsePptx(bytes) {
  const files = unzip(bytes);
  const pres = readEntry(files, "ppt/presentation.xml");
  if (!pres) throw new Error("This doesn't look like a PowerPoint (.pptx) file.");
  const rels = relsMap(readEntry(files, "ppt/_rels/presentation.xml.rels"));
  // <p:sldId id="256" r:id="rId2"/> — the relationship id is the *prefixed* one; a plain
  // attr(s, "id") would return the numeric slide id and lose the real slide order.
  const relId = (s) => {
    const a = Array.from(s.attributes || []).find((x) => /:id$/.test(String(x.name)) && !/^xml/.test(String(x.name)));
    return a ? a.value : null;
  };
  const ids = findAll(parseXml(pres).documentElement, "sldId").map(relId);
  let slidePaths = ids.map((id) => resolvePath("ppt", rels[id])).filter((p) => files[p]);
  if (!slidePaths.length) {
    slidePaths = Object.keys(files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  }

  const pages = [];
  slidePaths.forEach((path, i) => {
    const slide = parseXml(readEntry(files, path));
    const blocks = [];
    const tree = findFirst(slide.documentElement, "spTree");
    if (tree) pptxShapeBlocks(tree, blocks);

    const dir = path.slice(0, path.lastIndexOf("/"));
    const slideRels = relsMap(readEntry(files, `${dir}/_rels/${path.split("/").pop()}.rels`));
    for (const target of Object.values(slideRels)) {
      if (!/notesSlide/.test(target || "")) continue;
      const notesPath = resolvePath(dir, target);
      const notesXml = readEntry(files, notesPath);
      if (!notesXml) continue;
      const nTree = findFirst(parseXml(notesXml).documentElement, "spTree");
      const noteBlocks = [];
      if (nTree) {
        for (const sp of elementChildren(nTree).filter((c) => nm(c) === "sp")) {
          const ph = findFirst(sp, "ph");
          if (!ph || attr(ph, "type") !== "body") continue;
          for (const p of findAll(sp, "p")) {
            const t = drawingParagraphText(p).trim();
            if (t) noteBlocks.push(t);
          }
        }
      }
      if (noteBlocks.length) blocks.push({ t: "p", text: `Speaker notes: ${noteBlocks.join(" ")}` });
    }
    pages.push(makePage(blocks.length ? blocks : [{ t: "p", text: "(No text on this slide.)" }], `Slide ${i + 1}`));
  });
  if (!pages.length) throw new Error("This presentation has no slides.");
  return pages;
}

// ---------- XLSX ----------

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code) {
  const stripped = String(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped) && !/^(general|0|#)/i.test(stripped.trim());
}

function excelSerialToString(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  if (serial < 1) return iso.slice(11, 19);
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

function sharedStrings(xmlStr) {
  if (!xmlStr) return [];
  return findAll(parseXml(xmlStr).documentElement, "si").map((si) =>
    findAll(si, "t")
      .filter((t) => nm(t.parentNode) !== "rPh") // skip phonetic hints
      .map((t) => t.textContent)
      .join("")
  );
}

function dateStyles(stylesXml) {
  const dateXf = new Set();
  if (!stylesXml) return dateXf;
  const root = parseXml(stylesXml).documentElement;
  const custom = {};
  for (const f of findAll(root, "numFmt")) custom[attr(f, "numFmtId")] = attr(f, "formatCode");
  const cellXfs = findFirst(root, "cellXfs");
  if (!cellXfs) return dateXf;
  elementChildren(cellXfs).forEach((xf, i) => {
    const id = attr(xf, "numFmtId");
    if (BUILTIN_DATE_FMTS.has(Number(id)) || (custom[id] && isDateFormatCode(custom[id]))) dateXf.add(String(i));
  });
  return dateXf;
}

export function parseXlsx(bytes) {
  const files = unzip(bytes);
  const wbXml = readEntry(files, "xl/workbook.xml");
  if (!wbXml) throw new Error("This doesn't look like an Excel (.xlsx) file.");
  const rels = relsMap(readEntry(files, "xl/_rels/workbook.xml.rels"));
  const strings = sharedStrings(readEntry(files, "xl/sharedStrings.xml"));
  const dateXf = dateStyles(readEntry(files, "xl/styles.xml"));

  const sheets = findAll(parseXml(wbXml).documentElement, "sheet").map((s) => ({
    name: attr(s, "name") || "Sheet",
    path: resolvePath("xl", rels[attr(s, "id")]),
  }));

  const pages = [];
  for (const sheet of sheets) {
    const xml = readEntry(files, sheet.path);
    if (!xml) continue;
    const rows = [];
    const data = findFirst(parseXml(xml).documentElement, "sheetData");
    if (data) {
      let rowNo = 0;
      for (const row of elementChildren(data).filter((c) => nm(c) === "row")) {
        const rIdx = (Number(attr(row, "r")) || rowNo + 1) - 1;
        rowNo = rIdx + 1;
        if (rIdx >= MAX_SHEET_ROWS) break;
        const cells = [];
        let cursor = 0;
        for (const c of elementChildren(row).filter((x) => nm(x) === "c")) {
          const ref = attr(c, "r");
          const idx = ref ? colIndex(ref) : cursor;
          cursor = idx + 1;
          if (idx >= MAX_SHEET_COLS) continue;
          const type = attr(c, "t");
          const vEl = elementChildren(c).find((x) => nm(x) === "v");
          let value = vEl ? vEl.textContent : "";
          if (type === "s") value = strings[Number(value)] ?? "";
          else if (type === "inlineStr") value = findAll(c, "t").map((t) => t.textContent).join("");
          else if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
          else if (type !== "str" && type !== "e" && value !== "" && dateXf.has(String(attr(c, "s")))) {
            const num = Number(value);
            if (Number.isFinite(num)) value = excelSerialToString(num);
          }
          while (cells.length < idx) cells.push("");
          cells[idx] = value;
        }
        while (rows.length < rIdx) rows.push([]);
        rows[rIdx] = cells;
      }
    }
    pages.push(...tablePages(rows, sheet.name));
  }
  if (!pages.length) throw new Error("This workbook has no readable sheets.");
  return pages;
}

// ---------- OpenDocument ----------

function odfInlineText(el) {
  let out = "";
  for (const node of Array.from(el.childNodes || [])) {
    if (node.nodeType === 3) {
      out += node.nodeValue;
    } else if (node.nodeType === 1) {
      const name = nm(node);
      if (name === "s") out += " ".repeat(Math.min(50, Number(attr(node, "c")) || 1));
      else if (name === "tab") out += "\t";
      else if (name === "line-break") out += "\n";
      else if (name === "annotation" || name === "annotation-end") continue;
      else out += odfInlineText(node);
    }
  }
  return out;
}

function odfTableRows(table) {
  const rows = [];
  for (const tr of walk(table)) {
    if (nm(tr) !== "table-row") continue;
    const repeatRows = Math.min(Number(attr(tr, "number-rows-repeated")) || 1, 200);
    const cells = [];
    for (const tc of elementChildren(tr)) {
      const name = nm(tc);
      if (name !== "table-cell" && name !== "covered-table-cell") continue;
      const repeat = Math.min(Number(attr(tc, "number-columns-repeated")) || 1, 40);
      let value = findAll(tc, "p").map((p) => odfInlineText(p)).join("\n");
      if (!value) {
        value = attr(tc, "date-value") || attr(tc, "value") || attr(tc, "boolean-value") || "";
      }
      for (let i = 0; i < repeat && cells.length < MAX_SHEET_COLS; i++) cells.push(value);
    }
    const isEmpty = cells.every((c) => c === "");
    for (let i = 0; i < (isEmpty ? Math.min(repeatRows, 1) : repeatRows); i++) {
      rows.push(cells.slice());
      if (rows.length >= MAX_SHEET_ROWS) return rows;
    }
  }
  return rows;
}

function odfTextBlocks(container, out) {
  for (const el of elementChildren(container)) {
    const name = nm(el);
    if (name === "h") {
      const text = odfInlineText(el).trim();
      if (text) out.push({ t: "h", level: Math.min(3, Number(attr(el, "outline-level")) || 1), text });
    } else if (name === "p") {
      const text = odfInlineText(el);
      if (text.trim()) out.push({ t: "p", text });
    } else if (name === "list") {
      for (const item of findAll(el, "list-item")) {
        for (const p of elementChildren(item).filter((c) => nm(c) === "p" || nm(c) === "h")) {
          const text = odfInlineText(p).trim();
          if (text) out.push({ t: "p", text: `• ${text}` });
        }
      }
    } else if (name === "table") {
      const rows = trimGrid(odfTableRows(el));
      if (rows.length) out.push({ t: "table", rows });
    } else if (name === "section" || name === "text" || name === "body") {
      odfTextBlocks(el, out);
    }
  }
}

export function parseOdf(bytes, ext) {
  const files = unzip(bytes);
  const xml = readEntry(files, "content.xml");
  if (!xml) throw new Error("This doesn't look like an OpenDocument file.");
  const root = parseXml(xml).documentElement;
  const body = findFirst(root, "body");
  if (!body) throw new Error("This OpenDocument file has no content.");

  if (ext === "ods") {
    const pages = [];
    for (const table of findAll(body, "table")) {
      if (nm(table.parentNode) !== "spreadsheet") continue;
      pages.push(...tablePages(odfTableRows(table), attr(table, "name") || "Sheet"));
    }
    if (!pages.length) throw new Error("This spreadsheet has no readable sheets.");
    return pages;
  }

  if (ext === "odp") {
    const pages = [];
    findAll(body, "page").forEach((page, i) => {
      if (nm(page.parentNode) !== "presentation") return;
      const blocks = [];
      for (const frame of findAll(page, "frame")) {
        const inNotes = (() => {
          for (let n = frame.parentNode; n && n !== page; n = n.parentNode) if (nm(n) === "notes") return true;
          return false;
        })();
        const isTitle = attr(frame, "class") === "title";
        for (const p of findAll(frame, "p")) {
          const text = odfInlineText(p).trim();
          if (!text) continue;
          if (inNotes) blocks.push({ t: "p", text: `Speaker notes: ${text}` });
          else if (isTitle) blocks.push({ t: "h", level: 1, text });
          else blocks.push({ t: "p", text });
        }
      }
      pages.push(makePage(blocks.length ? blocks : [{ t: "p", text: "(No text on this slide.)" }], `Slide ${i + 1}`));
    });
    if (!pages.length) throw new Error("This presentation has no slides.");
    return pages;
  }

  const blocks = [];
  const text = findFirst(body, "text");
  odfTextBlocks(text || body, blocks);
  const pages = paginateBlocks(blocks);
  return pages.length ? pages : [makePage([{ t: "p", text: "(This document has no text.)" }])];
}

// ---------- plain-ish text formats ----------

export function decodeText(bytes) {
  const u8 = new Uint8Array(bytes);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, "");
  } catch {
    // Not valid UTF-8 — almost always an old Windows-1252 export. Better than mojibake.
    return new TextDecoder("windows-1252").decode(u8);
  }
}

export function parsePlainText(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/).map((s) => s.replace(/^\n+|\s+$/g, "")).filter((s) => s.trim());
  const blocks = paragraphs.map((p) => ({ t: "p", text: p }));
  const pages = paginateBlocks(blocks);
  return pages.length ? pages : [makePage([{ t: "p", text: "(This file is empty.)" }])];
}

function codePages(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const pages = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    if (cur.length && (size + line.length > PAGE_CHARS * 1.4 || cur.length >= 120)) {
      pages.push(makePage([{ t: "code", text: cur.join("\n") }]));
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.some((l) => l.trim())) pages.push(makePage([{ t: "code", text: cur.join("\n") }]));
  return pages.length ? pages : [makePage([{ t: "p", text: "(This file is empty.)" }])];
}

export function parseCsv(text, ext) {
  const delimiter = ext === "tsv" ? "\t" : sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  return tablePages(rows, "Table");
}

export function parseJson(text) {
  try {
    return codePages(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    return codePages(text); // not valid JSON — show it as written rather than refusing
  }
}

const SKIP_HTML = new Set(["script", "style", "noscript", "template", "head", "svg", "canvas"]);
const BLOCK_HTML = new Set(["p", "li", "blockquote", "dd", "dt", "figcaption", "summary", "pre", "div", "section", "article", "tr", "address"]);

export function parseHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const blocks = [];
  let inline = "";
  const flush = () => {
    const t = inline.replace(/\s+/g, " ").trim();
    if (t) blocks.push({ t: "p", text: t });
    inline = "";
  };
  const visit = (node) => {
    if (node.nodeType === 3) {
      inline += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.localName || node.nodeName).toLowerCase();
    if (SKIP_HTML.has(tag)) return;
    if (tag === "table") {
      flush();
      const rows = [];
      for (const tr of Array.from(node.querySelectorAll("tr"))) {
        rows.push(Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.nodeName)).map((c) => c.textContent.replace(/\s+/g, " ").trim()));
      }
      const clean = trimGrid(rows);
      if (clean.length) blocks.push({ t: "table", rows: clean });
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      flush();
      const t = node.textContent.replace(/\s+/g, " ").trim();
      if (t) blocks.push({ t: "h", level: Math.min(3, Number(tag[1])), text: t });
      return;
    }
    if (tag === "pre") {
      flush();
      const t = node.textContent.replace(/\s+$/, "");
      if (t.trim()) blocks.push({ t: "code", text: t });
      return;
    }
    if (tag === "br") {
      inline += " ";
      return;
    }
    const isBlock = BLOCK_HTML.has(tag);
    if (isBlock) flush();
    if (tag === "li") inline += "• ";
    for (const child of Array.from(node.childNodes)) visit(child);
    if (isBlock) flush();
  };
  visit(doc.body || doc.documentElement);
  flush();
  const pages = paginateBlocks(blocks);
  return pages.length ? pages : [makePage([{ t: "p", text: "(This page has no visible text.)" }])];
}

export function parseRtf(text) {
  let s = text;
  // Drop groups that never contain visible text.
  for (const name of ["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "themedata", "colorschememapping", "latentstyles", "datastore"]) {
    const re = new RegExp(String.raw`\{(?:\\\*)?\\${name}\b`, "g");
    let m;
    while ((m = re.exec(s))) {
      let depth = 0;
      let end = m.index;
      for (; end < s.length; end++) {
        if (s[end] === "\\") end++;
        else if (s[end] === "{") depth++;
        else if (s[end] === "}" && --depth === 0) break;
      }
      s = s.slice(0, m.index) + s.slice(end + 1);
      re.lastIndex = m.index;
    }
  }
  // \'hh bytes use the file's declared code page (\ansicpgN), not always Windows-1252.
  const cp = Number((s.match(/\\ansicpg(\d+)/) || [])[1]);
  let decoder;
  try {
    decoder = new TextDecoder(cp >= 1250 && cp <= 1258 || cp === 874 ? `windows-${cp}` : "windows-1252");
  } catch {
    decoder = new TextDecoder("windows-1252");
  }
  // One left-to-right pass, so an escaped brace or backslash can never be mistaken for
  // markup by a later replacement (the old chained replaces ate literal "\temp" and "{}").
  s = s.replace(
    /\\'([0-9a-fA-F]{2})|\\u(-?\d+)[^\\{}]?|\\([{}\\])|\\(?:par|line|row)\b ?|\\(?:tab|cell)\b ?|\\[a-zA-Z]+-?\d* ?|[{}]/g,
    (m, hex, uni, lit) => {
      if (hex) return decoder.decode(new Uint8Array([parseInt(hex, 16)]));
      if (uni) return String.fromCharCode(Number(uni) < 0 ? Number(uni) + 65536 : Number(uni));
      if (lit) return lit;
      if (/^\\(par|line|row)/.test(m)) return "\n";
      if (/^\\(tab|cell)/.test(m)) return "\t";
      return "";
    }
  );
  return parsePlainText(s);
}

// ---------- dispatcher for everything that isn't a PDF or an image ----------

export async function loadTextPages(file, info) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`That file is ${(file.size / 1048576).toFixed(0)} MB — the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  const buf = await file.arrayBuffer();
  switch (info.kind) {
    case "docx": return parseDocx(buf);
    case "pptx": return parsePptx(buf);
    case "xlsx": return parseXlsx(buf);
    case "odf": return parseOdf(buf, info.ext);
    case "csv": return parseCsv(decodeText(buf), info.ext);
    case "json": return parseJson(decodeText(buf));
    case "xml": return codePages(decodeText(buf));
    case "html": return parseHtml(decodeText(buf));
    case "rtf": return parseRtf(decodeText(buf));
    default: return parsePlainText(decodeText(buf));
  }
}

// ---------- images → canvases (browser only) ----------

const MIN_LONG_EDGE = 1600; // small photos are upscaled so Tesseract sees realistic glyph sizes
const MAX_LONG_EDGE = 3500;

function fitToCanvas(source, w, h) {
  const long = Math.max(w, h);
  let scale = 1;
  if (long < MIN_LONG_EDGE) scale = Math.min(3, MIN_LONG_EDGE / long);
  else if (long > MAX_LONG_EDGE) scale = MAX_LONG_EDGE / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs would otherwise OCR as black-on-black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function decodeTiff(buf) {
  const { default: UTIF } = await import("../lib/utif/utif.min.js");
  let ifds;
  try {
    ifds = UTIF.decode(buf);
  } catch {
    throw new Error("Couldn't read this TIFF — it may be damaged.");
  }
  const canvases = [];
  for (const ifd of ifds) {
    try {
      UTIF.decodeImage(buf, ifd);
      if (!ifd.width || !ifd.height) continue;
      const rgba = UTIF.toRGBA8(ifd);
      const src = document.createElement("canvas");
      src.width = ifd.width;
      src.height = ifd.height;
      src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), ifd.width, ifd.height), 0, 0);
      canvases.push(fitToCanvas(src, ifd.width, ifd.height));
    } catch {
      /* skip thumbnails / unsupported sub-images */
    }
  }
  if (!canvases.length) throw new Error("This TIFF uses a compression the browser reader doesn't support. Convert it to PDF or PNG and try again.");
  return canvases;
}

/** @returns {Promise<HTMLCanvasElement[]>} one canvas per image / TIFF frame */
export async function decodeImagePages(file, info) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`That file is ${(file.size / 1048576).toFixed(0)} MB — the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
  if (info.kind === "tiff") return decodeTiff(await file.arrayBuffer());
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Your browser couldn't decode this image. Try saving it as PNG or JPG.");
  }
  const canvas = fitToCanvas(bitmap, bitmap.width, bitmap.height);
  bitmap.close && bitmap.close();
  return [canvas];
}
