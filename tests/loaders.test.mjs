import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
globalThis.DOMParser = DOMParser;

const L = await import("../js/loaders.js");
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const ab = (n) => { const b = fx(n); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const all = (pages) => pages.map((p) => p.text).join("\n");

test("classify by extension and mime", () => {
  assert.equal(L.classify({ name: "A.PDF", type: "" }).kind, "pdf");
  assert.equal(L.classify({ name: "x.docx" }).kind, "docx");
  assert.equal(L.classify({ name: "scan.TIFF" }).kind, "tiff");
  assert.equal(L.classify({ name: "old.doc" }).kind, "legacy");
  assert.equal(L.classify({ name: "pic.heic" }).kind, "heic");
  assert.equal(L.classify({ name: "image", type: "image/png" }).kind, "image");
  assert.equal(L.classify({ name: "weird.zzz", type: "" }).kind, "unknown");
  assert.match(L.unsupportedMessage({}, L.classify({ name: "a.doc" })), /\.docx/);
});

test("docx: headings, bullets, tables, unicode, pagination", () => {
  const pages = L.parseDocx(ab("report.docx"));
  assert.ok(pages.length >= 2, "long document splits into pages");
  const text = all(pages);
  assert.match(text, /Quarterly Report/);
  assert.match(text, /Revenue grew by twelve percent/);
  assert.match(text, /• First bullet item/);
  assert.match(text, /नमस्ते दुनिया/);
  const table = pages.flatMap((p) => p.blocks).find((b) => b.t === "table");
  assert.deepEqual(table.rows[1], ["North", "100", "120"]);
  const heads = pages.flatMap((p) => p.blocks).filter((b) => b.t === "h").map((b) => b.text);
  assert.ok(heads.includes("Revenue summary"));
});

test("pptx: slide order, titles, table, speaker notes", () => {
  const pages = L.parsePptx(ab("deck.pptx"));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, "Slide 1");
  assert.match(pages[0].text, /Launch plan/);
  assert.match(pages[0].text, /Ship the beta in March/);
  assert.match(pages[0].text, /Speaker notes: Remember to mention the pricing/);
  assert.equal(pages[0].blocks[0].t, "h");
  assert.deepEqual(pages[1].blocks.find((b) => b.t === "table").rows, [["Metric", "Value"], ["Users", "4200"]]);
});

test("xlsx: shared strings, dates, booleans, formulas, multiple sheets", () => {
  const pages = L.parseXlsx(ab("book.xlsx"));
  assert.deepEqual(pages.map((p) => p.title), ["Sales", "Notes"]);
  const rows = pages[0].blocks[0].rows;
  assert.deepEqual(rows[0], ["Date", "Item", "Amount", "Paid"]);
  assert.equal(rows[1][0], "2026-03-14");
  assert.equal(rows[1][3], "TRUE");
  assert.equal(rows[2][0], "2026-03-15 13:30:00");
  assert.equal(rows[2][1], "Gadget, large");
  assert.equal(rows[2][3], "FALSE");
  assert.equal(pages[1].blocks[0].rows[0][0], 'Contains quote "x"');
});

test("odt / ods / odp parse like their OOXML twins", () => {
  const odt = all(L.parseOdf(ab("report.odt"), "odt"));
  assert.match(odt, /Revenue grew by twelve percent/);
  assert.match(odt, /नमस्ते दुनिया/);
  const ods = L.parseOdf(ab("book.ods"), "ods");
  assert.deepEqual(ods.map((p) => p.title), ["Sales", "Notes"]);
  assert.match(ods[0].text, /Widget/);
  const odp = L.parseOdf(ab("deck.odp"), "odp");
  assert.equal(odp.length, 2);
  assert.match(odp[0].text, /Launch plan/);
});

test("csv: delimiter sniffing, quoted newlines, cp1252 fallback", () => {
  const semi = L.parseCsv(L.decodeText(ab("semi.csv")), "csv")[0].blocks[0].rows;
  assert.deepEqual(semi, [["name", "city", "note"], ["Asha", "Pune", "line one\nline two"], ["Ravi", "Delhi", "ok"]]);
  const latin = L.parseCsv(L.decodeText(ab("latin1.csv")), "csv")[0].blocks[0].rows;
  assert.deepEqual(latin[1], ["René", "Genève"]);
});

test("txt, json, html, rtf", () => {
  const txt = L.parsePlainText(L.decodeText(ab("plain.txt")));
  assert.equal(txt[0].blocks.length, 2);
  assert.equal(txt[0].blocks[0].text, "First paragraph\nstill first.");
  assert.match(L.parseJson(L.decodeText(ab("data.json")))[0].text, /"list": \[/);
  const html = L.parseHtml(L.decodeText(ab("page.html")));
  const t = html[0].text;
  assert.match(t, /Heading One/);
  assert.match(t, /Hello bold world/);
  assert.match(t, /• one/);
  assert.doesNotMatch(t, /alert/);
  assert.deepEqual(html[0].blocks.find((b) => b.t === "table").rows, [["A", "B"], ["1", "2"]]);
  const rtf = L.parseRtf(L.decodeText(ab("doc.rtf")))[0].text;
  assert.match(rtf, /Hello world/);
  assert.match(rtf, /Café time/);
  assert.doesNotMatch(rtf, /Arial/);
});

test("corrupt archives give a readable error, not a crash", () => {
  assert.throws(() => L.parseDocx(new TextEncoder().encode("not a zip").buffer), /valid Office|damaged/);
  assert.throws(() => L.parseXlsx(new Uint8Array([1, 2, 3]).buffer), /valid Office|damaged/);
});
