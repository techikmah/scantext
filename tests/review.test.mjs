// Regression tests for bugs found by the independent code review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
globalThis.DOMParser = DOMParser;

const L = await import("../js/loaders.js");
const U = await import("../js/text-utils.js");
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const ab = (n) => { const b = fx(n); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

test("pptx: slide order follows the slide list, not the file numbers", () => {
  const pages = L.parsePptx(ab("deck-reordered.pptx"));
  assert.equal(pages.length, 2);
  assert.match(pages[0].text, /Users/, "slide2.xml comes first in the reordered deck");
  assert.match(pages[1].text, /Launch plan/);
});

test("rtf: escaped braces and backslashes survive, \\uN fallback is not duplicated", () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252 Path C:\\temp and \{braces\} caf\u233? \'e9}`;
  const text = L.parseRtf(rtf)[0].text;
  assert.match(text, /C:\\temp/);
  assert.match(text, /\{braces\}/);
  assert.match(text, /café é/);
  assert.doesNotMatch(text, /caf[eé]\?/);
});

test("rtf: Cyrillic bytes follow the declared code page", () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2}`;
  assert.match(L.parseRtf(rtf)[0].text, /Привет/);
});

test("csv export: formula-looking text is defused, plain numbers are not", () => {
  assert.equal(U.csvEscape("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(U.csvEscape("@cmd"), "'@cmd");
  assert.equal(U.csvEscape("-5"), "-5");
  assert.equal(U.csvEscape("+91 98765"), "+91 98765");
  assert.equal(U.csvEscape("plain"), "plain");
});

test("search offsets stay valid with decomposed accents and length-changing case folds", () => {
  const nfc = "Cafe\u0301 au lait, café noir".normalize("NFC");
  const occ = U.findTextOccurrences(nfc, "café");
  assert.equal(occ.length, 2);
  for (const o of occ) assert.equal(nfc.slice(o.index, o.index + o.length).toLowerCase(), "café");

  const tricky = "İstanbul and istanbul"; // İ lowercases to two code units
  const hits = U.findTextOccurrences(tricky, "and");
  assert.equal(hits.length, 1);
  assert.equal(tricky.slice(hits[0].index, hits[0].index + hits[0].length), "and");
});
