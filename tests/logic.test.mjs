import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
globalThis.DOMParser = DOMParser;

const U = await import("../js/text-utils.js");
const T = await import("../js/translate.js");
const E = await import("../js/exporters.js");

const W = (text, x0, y0 = 0) => ({ text, x0, x1: x0 + 10, y0, y1: y0 + 10 });

test("lines: words on one baseline join, new baseline breaks", () => {
  const words = [W("Hello", 0), W("world", 20), W("Next", 0, 30)];
  assert.equal(U.pageTextFromWords(words), "Hello world\nNext");
});

test("word search: single token, phrase, punctuation, no overlap", () => {
  const words = ["Mr.", "Smith,", "John", "A.", "Smith", "John"].map((t, i) => W(t, i * 20));
  assert.deepEqual(U.findWordMatches(words, "smi"), [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
  // punctuation is forgiven in phrases, since OCR often drops or adds commas
  assert.deepEqual(U.findWordMatches(words, "smith, john"), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
  assert.deepEqual(U.findWordMatches(words, "smith john"), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
  assert.deepEqual(U.findWordMatches(words, "zzz"), []);
  assert.deepEqual(U.findWordMatches(words, "  "), []);
});

test("text occurrences are case-insensitive and whitespace-tolerant", () => {
  assert.deepEqual(U.findTextOccurrences("Alpha beta\n  Beta", "BETA"), [{ index: 6, length: 4 }, { index: 13, length: 4 }]);
  assert.equal(U.findTextOccurrences("a   b", "a b").length, 1);
  assert.equal(U.findTextOccurrences("1+1=2 (x)", "(x)").length, 1, "regex metacharacters are literal");
  assert.equal(U.findTextOccurrences("नमस्ते दुनिया", "दुनिया").length, 1);
});

test("csv escape + parse round-trip", () => {
  const rows = [["a,b", 'say "hi"', "line1\nline2", "plain"]];
  const csv = rows.map((r) => r.map(U.csvEscape).join(",")).join("\r\n");
  assert.deepEqual(U.parseDelimited(csv), rows);
  assert.deepEqual(U.parseDelimited("a,b\n"), [["a", "b"]]);
});

test("chunking respects char and byte limits and keeps all text", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Line number ${i} has some words`).join("\n");
  const chunks = U.chunkText(text, { maxChars: 100 });
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join("\n"), text);

  const hindi = "यह एक बहुत लंबा वाक्य है जो बाइट सीमा से अधिक होगा। ".repeat(12).trim();
  const hc = U.chunkText(hindi, { maxChars: 450, maxBytes: 480 });
  assert.ok(hc.length > 1);
  assert.ok(hc.every((c) => U.utf8Length(c) <= 480), "every chunk within 480 bytes");
  assert.equal(hc.join(" ").replace(/\s+/g, " "), hindi.replace(/\s+/g, " "));

  const emoji = "😀".repeat(300);
  const ec = U.chunkText(emoji, { maxChars: 100, maxBytes: 0 });
  assert.ok(ec.every((c) => !/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c)), "no torn surrogate pairs");
  assert.equal(U.chunkText("", { maxChars: 50 }).length, 0);
});

test("language detection: scripts, Latin stopwords, hints", () => {
  assert.equal(U.detectLanguage("यह एक परीक्षण दस्तावेज़ है").code, "hi");
  assert.equal(U.detectLanguage("यह एक परीक्षण दस्तावेज़ है", ["mr"]).code, "mr");
  assert.equal(U.detectLanguage("இது ஒரு சோதனை ஆவணம்").code, "ta");
  assert.equal(U.detectLanguage("هذا مستند اختبار").code, "ar");
  assert.equal(U.detectLanguage("هذا مستند اختبار", ["ur"]).code, "ur");
  assert.equal(U.detectLanguage("これは日本語のテストです").code, "ja");
  assert.equal(U.detectLanguage("这是一个测试文件").code, "zh");
  assert.equal(U.detectLanguage("Это тестовый документ для проверки").code, "ru");
  assert.equal(U.detectLanguage("The quick brown fox is in the garden and it was for the best").code, "en");
  assert.equal(U.detectLanguage("El perro de la casa no es del vecino y que lo sabe todo").code, "es");
  assert.equal(U.detectLanguage("Le chat est sur la table et les enfants sont dans le jardin").code, "fr");
  assert.equal(U.detectLanguage("Der Hund ist nicht in dem Haus und die Katze auch nicht").code, "de");
  assert.equal(U.detectLanguage("12345 !!").confidence, "low");
  assert.equal(U.detectLanguage("zzz qqq", ["fr"]).code, "fr");
});

// ---------- translate engines with a fake fetch ----------

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}
const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

test("MyMemory: request shape, entity decoding, multiple chunks, caching", async () => {
  const calls = fakeFetch((url) => {
    const q = new URL(url).searchParams.get("q");
    return json({ responseData: { translatedText: `T(${q})&#39;s &amp; &quot;ok&quot;` }, responseStatus: 200 });
  });
  const cache = new Map();
  const c = { get: (k) => cache.get(k) ?? null, set: (k, v) => cache.set(k, v) };
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about nothing`).join("\n");
  const out = await T.translateText(text, { engine: T.myMemoryEngine, src: "en", tgt: "zh", cfg: { myMemoryEmail: "a@b.co" }, cache: c });
  const first = new URL(calls[0].url);
  assert.equal(first.host, "api.mymemory.translated.net");
  assert.equal(first.searchParams.get("langpair"), "en|zh-CN");
  assert.equal(first.searchParams.get("de"), "a@b.co");
  assert.ok(calls.length > 1, "long text is split into several requests");
  assert.match(out, /'s & "ok"/);
  const before = calls.length;
  await T.translateText(text, { engine: T.myMemoryEngine, src: "en", tgt: "zh", cfg: {}, cache: c });
  assert.equal(calls.length, before, "second run served from cache");
});

test("MyMemory: quota warning inside a 200 response is a quota error", async () => {
  fakeFetch(() => json({ responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY." }, responseStatus: 200 }));
  await assert.rejects(T.translateText("hello", { engine: T.myMemoryEngine, src: "en", tgt: "fr" }), (e) => e.kind === "quota" && /daily limit/.test(e.message));
  fakeFetch(() => json({}, 429));
  await assert.rejects(T.translateText("hello", { engine: T.myMemoryEngine, src: "en", tgt: "fr" }), (e) => e.kind === "quota");
});

test("network failures retry twice then surface", async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError("offline"); };
  await assert.rejects(T.translateText("hello", { engine: T.myMemoryEngine, src: "en", tgt: "fr" }), (e) => e.kind === "network");
  assert.equal(n, 3);
});

test("LibreTranslate: POST body, key, trailing slash, errors", async () => {
  const calls = fakeFetch((_u, init) => json({ translatedText: JSON.parse(init.body).q.toUpperCase() }));
  const out = await T.translateText("hola", { engine: T.libreEngine, src: "es", tgt: "zh-TW", cfg: { libreUrl: "https://lt.example.org/", libreKey: "K" } });
  assert.equal(out, "HOLA");
  assert.equal(calls[0].url, "https://lt.example.org/translate");
  assert.deepEqual(JSON.parse(calls[0].init.body), { q: "hola", source: "es", target: "zt", format: "text", api_key: "K" });
  fakeFetch(() => json({ error: "Invalid API key" }, 400));
  await assert.rejects(T.translateText("x y", { engine: T.libreEngine, src: "es", tgt: "en", cfg: { libreUrl: "https://lt.example.org" } }), /Invalid API key/);
  await assert.rejects(T.translateText("x", { engine: T.libreEngine, src: "es", tgt: "en", cfg: {} }), (e) => e.kind === "config");
});

test("Chrome engine: pair availability, create once, translate", async () => {
  let created = 0;
  globalThis.Translator = {
    availability: async ({ sourceLanguage, targetLanguage }) => (targetLanguage === "xx" ? "unavailable" : "downloadable"),
    create: async ({ sourceLanguage, targetLanguage, monitor }) => {
      created++;
      monitor({ addEventListener: (_n, cb) => cb({ loaded: 0.5 }) });
      return { translate: async (t) => `[${sourceLanguage}>${targetLanguage}] ${t}` };
    },
  };
  assert.equal(await T.chromeEngine.supports("en", "hi"), true);
  assert.equal(await T.chromeEngine.supports("en", "xx"), false);
  let progress = 0;
  const a = await T.translateText("hello", { engine: T.chromeEngine, src: "en", tgt: "zh-TW", cfg: { onDownload: (p) => (progress = p) } });
  assert.equal(a, "[en>zh-Hant] hello");
  await T.translateText("again", { engine: T.chromeEngine, src: "en", tgt: "zh-TW" });
  assert.equal(created, 1, "translator reused");
  assert.equal(progress, 0.5);
  delete globalThis.Translator;
  assert.equal(await T.chromeEngine.supports("en", "hi"), false);
});

test("a browser that never answers availability() is treated as unavailable", async () => {
  globalThis.Translator = { availability: () => new Promise(() => {}), create: async () => ({}) };
  const saved = T.chromeEngine.probeTimeoutMs;
  T.chromeEngine.probeTimeoutMs = 40;
  assert.equal(await T.chromeEngine.supports("en", "hi"), false);
  assert.equal((await T.pickEngine("auto", "en", "hi", {})).id, "mymemory", "auto falls through to the next engine");
  globalThis.LanguageDetector = { create: () => new Promise(() => {}) };
  const r = await T.detectSource("zzz qqq", ["fr"]);
  assert.equal(r.code, "fr", "detector hang falls back to the heuristic");
  T.chromeEngine.probeTimeoutMs = saved;
  delete globalThis.Translator;
  delete globalThis.LanguageDetector;
});

test("engine selection: auto order, explicit choice, configuration errors", async () => {
  delete globalThis.Translator;
  assert.equal((await T.pickEngine("auto", "en", "hi", {})).id, "mymemory");
  assert.equal((await T.pickEngine("auto", "en", "hi", { libreUrl: "https://x.org" })).id, "libre");
  globalThis.Translator = { availability: async () => "available", create: async () => ({}) };
  assert.equal((await T.pickEngine("auto", "en", "hi", { libreUrl: "https://x.org" })).id, "chrome");
  delete globalThis.Translator;
  await assert.rejects(T.pickEngine("chrome", "en", "hi", {}), (e) => e.kind === "unsupported");
  await assert.rejects(T.pickEngine("libre", "en", "hi", {}), (e) => e.kind === "config");
  assert.match(T.describeEngine(T.myMemoryEngine, {}), /sent to api\.mymemory/);
  assert.match(T.describeEngine(T.chromeEngine, {}), /never leaves/);
});

test("abort stops between chunks; same-language is a no-op", async () => {
  const ac = new AbortController();
  let n = 0;
  globalThis.fetch = async () => { n++; ac.abort(); return json({ responseData: { translatedText: "x" }, responseStatus: 200 }); };
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i} of a fairly long text block`).join("\n");
  await assert.rejects(T.translateText(long, { engine: T.myMemoryEngine, src: "en", tgt: "fr", signal: ac.signal }), (e) => e.kind === "cancelled");
  assert.equal(n, 1);
  assert.equal(await T.translateText("same", { engine: T.myMemoryEngine, src: "en", tgt: "en" }), "same");
});

test("OCR language codes map to translation codes", () => {
  assert.deepEqual(T.ocrHints(["hin", "eng", "chi_tra", "equ"]), ["hi", "en", "zh-TW"]);
});

// ---------- exporters ----------

const model = {
  name: "invoice",
  pages: [
    { page: 1, source: "ocr", text: 'Total, due\n"Paid"', words: [W("Total,", 0)], translation: "कुल, देय" },
    { page: 2, source: "text", text: "Page two", translation: null },
  ],
  translation: { lang: "hi", langName: "Hindi", from: "en", engine: "Chrome, on this device" },
};

test("csv/json/txt exports carry original and translation", () => {
  const csv = E.buildCsv(model);
  assert.ok(csv.startsWith("﻿page,source,text,translation_hi"));
  assert.match(csv, /1,ocr,"Total, due\n""Paid""",/);
  const parsed = JSON.parse(E.buildJson(model));
  assert.equal(parsed.translation.to, "hi");
  assert.equal(parsed.pages[0].translation, "कुल, देय");
  assert.equal(parsed.pages[1].translation, null);
  assert.equal(parsed.pages[0].words.length, 1);
  assert.match(E.buildTxt(model, "translation"), /कुल, देय/);
  assert.doesNotMatch(E.buildTxt(model, "translation"), /Page two/);
  const noTr = { ...model, translation: null };
  assert.doesNotMatch(E.buildCsv(noTr), /translation/);
});

test("docx exports are valid zip files containing the text", async () => {
  const { unzipSync, strFromU8 } = await import("../lib/fflate/fflate.min.js");
  for (const which of ["original", "translation"]) {
    const blob = await E.buildDocxBlob(model, which);
    assert.ok(blob.size > 1000);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files["word/document.xml"]);
    assert.match(xml, which === "original" ? /Total, due/ : /कुल, देय/);
    if (which === "translation") assert.doesNotMatch(xml, /Page two/);
  }
  assert.equal(E.safeFileStem("My/Doc: v2.final.pdf"), "My_Doc_ v2.final");
});

test("scrambled complex-script text layers are detected, clean ones are not", () => {
  const W2 = (s) => s.split(" ").map((text) => ({ text }));
  assert.equal(U.hasBrokenShaping(W2("नमस् ते दु निन या , या ह एक प री क्ष ण ह")), true);
  assert.equal(U.hasBrokenShaping(W2("नमस्ते दुनिया यह एक परीक्षण है")), false);
  assert.equal(U.hasBrokenShaping(W2("plain English text with no marks at all")), false);
  assert.equal(U.hasBrokenShaping([]), false);
});
