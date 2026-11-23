// ScanText web app — main script.
//
// Shape of the app:
//   docs[]        every open document {id, name, kind, pages[], status, tr, …}
//   a "page" is   {kind:"canvas", words[], …}  (PDF page or image, with an OCR/text layer)
//              or {kind:"text", blocks[], …}   (Word/Excel/CSV/… already text)
//   search        runs over every open document; matches are navigated in the active one
//   translation   per document and per target language, one text per page
//
// Everything runs in the browser. The only network traffic is OCR language data on
// first use of a language, and translation if the user picks an online engine.

import * as pdfjsLib from "../lib/pdfjs/pdf.min.mjs";
import { hashBuffer, docCacheKey, getCachedDoc, saveCachedDoc, getSetting, setSetting, translationCache, clearTranslationMemory } from "./cache.js";
import { LANGUAGES, DEFAULT_LANGUAGES } from "./languages.js";
import { ACCEPT, classify, unsupportedMessage, isVisualKind, loadTextPages, decodeImagePages } from "./loaders.js";
import { ocrCanvas, prepareOcr, setLangPath, resetWorker, OCR_TIMEOUT_MS, withTimeout } from "./ocr.js";
import {
  TRANSLATE_LANGS, RTL_LANGS, langName, ocrHints, pickEngine, detectSource, translateText,
  describeEngine, engineHost, TranslateError, libreEngine,
} from "./translate.js";
import { buildCsv, buildJson, buildTxt, buildDocxBlob, safeFileStem } from "./exporters.js";
import { isSameLine, pageTextFromWords, findWordMatches, findTextOccurrences, hasBrokenShaping } from "./text-utils.js";
import { inject } from "@vercel/analytics"
inject
const LIB_BASE = new URL("../lib/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", LIB_BASE).href;

const RENDER_SCALE = 2.5;
const MIN_NATIVE_CHARS = 20;
const MAX_DISPLAY_WIDTH = 900;
const MAX_CANVAS_DIM = 3500;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const MANY_PAGES = 120;

// ---------- small DOM helpers ----------

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const errorMessage = (err) => (err && err.message ? err.message : String(err));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------- elements ----------

const appEl = $("app");
const benchEl = $("bench");
const pagesEl = $("pages");
const statusLine = $("statusLine");
const docListEl = $("docList");
const searchBar = $("searchBar");
const searchInput = $("searchInput");
const matchLabel = $("matchLabel");
const translateBtn = $("translateBtn");
const exportBtn = $("exportBtn");
const exportMenu = $("exportMenu");
const viewbar = $("viewbar");
const fileInput = $("fileInput");
const cameraInput = $("cameraInput");

// ---------- state ----------

const state = {
  docs: [],
  activeId: null,
  zoom: 1,
  query: "",
  activeHit: -1,
  settings: {
    ocrLangs: DEFAULT_LANGUAGES.slice(),
    enhance: true,
    engine: "auto",
    myMemoryEmail: "",
    libreUrl: "",
    libreKey: "",
    targetLang: "",
    consent: {},
  },
};
let nextDocId = 1;

const activeDoc = () => state.docs.find((d) => d.id === state.activeId) || null;
const docPageText = (p) => (p.kind === "canvas" ? pageTextFromWords(p.words) : p.text);

window.addEventListener("unhandledrejection", (e) => {
  console.error("ScanText: unhandled error", e.reason);
  setStatus(`Something went wrong: ${errorMessage(e.reason)}`, { warn: true });
});

// ---------- status line ----------

let statusTimer = null;
function setStatus(text, { warn = false, ms = 0 } = {}) {
  clearTimeout(statusTimer);
  statusLine.hidden = !text;
  statusLine.classList.toggle("is-warn", !!warn);
  statusLine.replaceChildren();
  if (text) {
    if (warn) statusLine.append(icon("alert"));
    statusLine.append(h("span", { text }));
  }
  if (text && ms) statusTimer = setTimeout(() => setStatus(""), ms);
}

// ---------- settings & theme ----------

async function loadSettings() {
  const s = state.settings;
  const [langs, enhance, engine, mm, lu, lk, tl, consent] = await Promise.all([
    getSetting("ocrLanguages"), getSetting("enhancePhotos"), getSetting("engine"), getSetting("myMemoryEmail"),
    getSetting("libreUrl"), getSetting("libreKey"), getSetting("targetLang"), getSetting("consent"),
  ]);
  if (Array.isArray(langs) && langs.length) s.ocrLangs = langs;
  if (typeof enhance === "boolean") s.enhance = enhance;
  if (typeof engine === "string") s.engine = engine;
  if (typeof mm === "string") s.myMemoryEmail = mm;
  if (typeof lu === "string") s.libreUrl = lu;
  if (typeof lk === "string") s.libreKey = lk;
  if (consent && typeof consent === "object") s.consent = consent;
  // No default target: guessing "English" would be wrong for most English documents.
  s.targetLang = typeof tl === "string" && TRANSLATE_LANGS.some((l) => l.code === tl) ? tl : "";
}

function effectiveTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t) return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

$("themeBtn").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("scantext-theme", next);
  } catch {
    /* private mode — the choice just won't persist */
  }
});

// Dialog focus handling: keep Tab inside the open dialog and give focus back on close.
let returnFocusTo = null;
function restoreFocus() {
  const el = returnFocusTo;
  returnFocusTo = null;
  if (el && el.isConnected && typeof el.focus === "function") el.focus();
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const dialog = [document.getElementById("consentPanel"), document.getElementById("settingsPanel")].find((p) => p && !p.hidden);
  if (!dialog) return;
  const items = Array.from(dialog.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")).filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!dialog.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// settings panel
const settingsPanel = $("settingsPanel");
const langSearchInput = $("langSearchInput");
const langOptions = $("langOptions");
const langSelected = $("langSelected");
let pendingLangs = [];

function openSettings() {
  pendingLangs = state.settings.ocrLangs.slice();
  $("enhanceToggle").checked = state.settings.enhance;
  $("engineSelect").value = state.settings.engine;
  $("mmEmail").value = state.settings.myMemoryEmail;
  $("libreUrl").value = state.settings.libreUrl;
  $("libreKey").value = state.settings.libreKey;
  langSearchInput.value = "";
  renderLangChips();
  renderLangOptions("");
  settingsPanel.hidden = false;
  returnFocusTo = document.activeElement;
  $("closeSettingsBtn").focus();
}

function closeSettings() {
  settingsPanel.hidden = true;
  restoreFocus();
}

$("settingsBtn").addEventListener("click", openSettings);
$("closeSettingsBtn").addEventListener("click", closeSettings);
settingsPanel.addEventListener("click", (e) => {
  if (e.target === settingsPanel) closeSettings();
});

$("applySettingsBtn").addEventListener("click", async () => {
  const s = state.settings;
  const langsChanged = pendingLangs.slice().sort().join() !== s.ocrLangs.slice().sort().join();
  s.ocrLangs = pendingLangs.slice();
  s.enhance = $("enhanceToggle").checked;
  s.engine = $("engineSelect").value;
  s.myMemoryEmail = $("mmEmail").value.trim();
  s.libreUrl = $("libreUrl").value.trim().replace(/\/+$/, "");
  s.libreKey = $("libreKey").value;
  closeSettings();
  await Promise.all([
    setSetting("ocrLanguages", s.ocrLangs), setSetting("enhancePhotos", s.enhance), setSetting("engine", s.engine),
    setSetting("myMemoryEmail", s.myMemoryEmail), setSetting("libreUrl", s.libreUrl), setSetting("libreKey", s.libreKey),
  ]);
  if (langsChanged && state.docs.some((d) => isVisualKind(d.info.kind))) {
    setStatus("Reading language changed. Documents already open keep their old reading — open them again to use the new language.", { ms: 7000 });
  }
  refreshEngineNote();
});

$("clearTrBtn").addEventListener("click", async () => {
  await clearTranslationMemory();
  for (const d of state.docs) d.tr.byLang = {};
  renderDrawer();
  refreshAllTray();
  setStatus("Saved translations cleared.", { ms: 3000 });
});

langSearchInput.addEventListener("input", () => renderLangOptions(langSearchInput.value));

function renderLangOptions(query) {
  const q = query.trim().toLowerCase();
  const list = q ? LANGUAGES.filter((l) => l.name.toLowerCase().includes(q) || l.code.includes(q)) : LANGUAGES;
  langOptions.replaceChildren();
  if (!list.length) {
    langOptions.append(h("div", { class: "hint", style: "padding:10px", text: "No languages match that search." }));
    return;
  }
  for (const lang of list) {
    langOptions.append(
      h(
        "button",
        {
          type: "button",
          class: "lang-option",
          role: "option",
          "aria-selected": String(pendingLangs.includes(lang.code)),
          onclick: () => toggleLang(lang.code),
        },
        h("span", { text: lang.name }),
        h("small", { text: lang.code })
      )
    );
  }
}

function renderLangChips() {
  langSelected.replaceChildren();
  for (const code of pendingLangs) {
    const lang = LANGUAGES.find((l) => l.code === code);
    langSelected.append(
      h(
        "span",
        { class: "lang-chip" },
        lang ? lang.name : code,
        h("button", { type: "button", "aria-label": `Remove ${lang ? lang.name : code}`, onclick: () => toggleLang(code) }, icon("close"))
      )
    );
  }
}

function toggleLang(code) {
  if (pendingLangs.includes(code)) {
    if (pendingLangs.length === 1) return; // at least one language is always needed
    pendingLangs = pendingLangs.filter((c) => c !== code);
  } else pendingLangs = [...pendingLangs, code];
  renderLangChips();
  const scroll = langOptions.scrollTop;
  renderLangOptions(langSearchInput.value);
  langOptions.scrollTop = scroll;
}

// ---------- adding files ----------

const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const added = [];
  const problems = [];
  for (const file of files) {
    const info = classify(file);
    if (info.kind === "legacy" || info.kind === "heic" || info.kind === "unknown") {
      problems.push(`${file.name}: ${unsupportedMessage(file, info)}`);
      continue;
    }
    const dup = state.docs.find((d) => sameFile(d.file, file));
    if (dup) {
      added.push(dup);
      continue;
    }
    added.push(createDoc(file, info));
  }
  if (problems.length) setStatus(problems.join("  "), { warn: true, ms: 12000 });
  if (added.length) selectDoc(added[0].id);
}

function createDoc(file, info) {
  const visual = isVisualKind(info.kind);
  const doc = {
    id: nextDocId++,
    file,
    name: file.name,
    stem: safeFileStem(file.name),
    info,
    visual,
    pages: [],
    status: "queued",
    done: 0,
    total: 0,
    error: null,
    closed: false,
    el: h("div", { class: "doc-pages", hidden: true }),
    ui: null,
    pdf: null,
    hash: null,
    cacheKey: null,
    hitTotal: 0,
    srcDetected: null,
    tr: { byLang: {}, running: false, ctl: null, error: null },
  };
  state.docs.push(doc);
  pagesEl.append(doc.el);
  buildTrayItem(doc);
  appEl.dataset.hasDocs = "true";
  searchBar.hidden = false;
  translateBtn.hidden = false;
  exportBtn.hidden = false;
  viewbar.hidden = false;
  $("trayToggle").hidden = false;
  renderTray();

  if (visual) {
    ocrQueue.push(doc);
    pumpQueue();
  } else {
    processTextDoc(doc).catch((err) => failDoc(doc, err));
  }
  return doc;
}

function failDoc(doc, err) {
  console.error(`ScanText: couldn't open ${doc.name}`, err);
  doc.status = "error";
  doc.error = errorMessage(err);
  refreshTrayItem(doc);
  if (doc.id === state.activeId) setStatus(`${doc.name}: ${doc.error}`, { warn: true });
}

function closeDoc(doc) {
  doc.closed = true;
  doc.tr.ctl && doc.tr.ctl.abort();
  try {
    doc.pdf && doc.pdf.destroy();
  } catch {
    /* already gone */
  }
  doc.el.remove();
  const idx = state.docs.indexOf(doc);
  state.docs.splice(idx, 1);
  doc.ui && doc.ui.li.remove();
  if (!state.docs.length) {
    state.activeId = null;
    appEl.dataset.hasDocs = "false";
    closeDrawer();
    searchBar.hidden = translateBtn.hidden = exportBtn.hidden = viewbar.hidden = true;
    $("trayToggle").hidden = true;
    setStatus("");
    updateMatchLabel();
    return;
  }
  if (state.activeId === doc.id) selectDoc(state.docs[Math.min(idx, state.docs.length - 1)].id);
  else renderTray();
}

// ---------- tray ----------

function kindGlyph(doc) {
  const ext = doc.info.ext || "";
  return (ext === "jpeg" ? "jpg" : ext === "tiff" ? "tif" : ext).slice(0, 4) || "file";
}

function buildTrayItem(doc) {
  const name = h("div", { class: "doc-name", text: doc.name, title: doc.name });
  const sub = h("div", { class: "doc-sub" });
  const hits = h("span", { class: "doc-hits", hidden: true });
  const close = h("button", { type: "button", class: "icon-btn flat doc-close", "aria-label": `Close ${doc.name}`, onclick: (e) => { e.stopPropagation(); closeDoc(doc); } }, icon("close"));
  const bar = h("div", { class: "doc-bar" }, h("i"));
  const li = h(
    "li",
    {
      class: "doc-item",
      "data-kind": doc.visual ? "visual" : "text",
      onclick: () => selectDoc(doc.id),
    },
    h("div", { class: "doc-kind", text: kindGlyph(doc) }),
    // The keyboard target is the name area; the close button beside it is a separate
    // control, so no interactive element is nested inside another.
    h("div", {
      class: "doc-main",
      tabindex: "0",
      role: "button",
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectDoc(doc.id);
        }
      },
    }, name, sub),
    h("div", { class: "doc-side" }, hits, close),
    bar
  );
  doc.ui = { li, sub, hits, bar: bar.firstChild, name };
  refreshTrayItem(doc);
}

function docSummary(doc) {
  if (doc.status === "error") return null;
  if (doc.status === "queued") return doc.visual ? "Waiting to be read" : "Opening…";
  if (doc.status === "processing") return doc.total ? `Reading page ${Math.min(doc.done + 1, doc.total)} of ${doc.total}` : "Opening…";
  const parts = [doc.info.label, plural(doc.pages.length, "page")];
  if (doc.pages.some((p) => p.source === "ocr")) parts.push("scanned");
  return parts.join(", ");
}

function refreshTrayItem(doc) {
  const ui = doc.ui;
  if (!ui) return;
  ui.li.setAttribute("aria-current", String(doc.id === state.activeId));
  ui.sub.replaceChildren();
  ui.sub.classList.toggle("is-error", doc.status === "error");
  if (doc.status === "error") ui.sub.textContent = doc.error;
  else {
    ui.sub.append(docSummary(doc));
    const translated = Object.entries(doc.tr.byLang).find(([, v]) => v.pages.some(Boolean));
    if (translated) {
      ui.sub.append(", ", h("span", { class: "tag-tr", text: `in ${langName(translated[0])}` }));
    }
  }
  const pct = doc.status === "done" || doc.status === "error" ? 0 : doc.total ? (doc.done / doc.total) * 100 : 4;
  ui.bar.style.width = `${pct}%`;
  const q = state.query;
  ui.hits.hidden = !q;
  if (q) {
    ui.hits.textContent = String(doc.hitTotal);
    ui.hits.title = `${plural(doc.hitTotal, "match", "matches")} in ${doc.name}`;
    ui.hits.style.opacity = doc.hitTotal ? "1" : "0.45";
  }
}

const refreshAllTray = () => state.docs.forEach(refreshTrayItem);

function renderTray() {
  docListEl.replaceChildren(...state.docs.map((d) => d.ui.li));
  refreshAllTray();
}

// On narrow screens the tray is an off-canvas panel: keep it out of the tab order while closed.
const narrowMq = window.matchMedia("(max-width: 900px)");
function syncTrayInert() {
  $("tray").inert = narrowMq.matches && appEl.dataset.tray !== "open";
}
function setTray(open) {
  appEl.dataset.tray = open ? "open" : "closed";
  syncTrayInert();
}
narrowMq.addEventListener("change", syncTrayInert);
syncTrayInert();
$("trayToggle").addEventListener("click", () => setTray(appEl.dataset.tray !== "open"));
$("addBtn").addEventListener("click", () => fileInput.click());

function selectDoc(id) {
  const doc = state.docs.find((d) => d.id === id);
  if (!doc) return;
  state.activeId = id;
  for (const d of state.docs) d.el.hidden = d.id !== id;
  refreshAllTray();
  state.activeHit = -1;
  fitAllPages(doc);
  runSearch(state.query, { fresh: true });
  benchEl.scrollTop = 0;
  if (doc.status === "error") setStatus(`${doc.name}: ${doc.error}`, { warn: true });
  else if (doc.status === "processing") setStatus(`Reading ${doc.name}…`);
  else setStatus("");
  renderDrawer();
  updatePageIndicator();
  if (narrowMq.matches) setTray(false);
}

// ---------- page shells ----------

function pageHead(title, badge, tools) {
  return h("div", { class: "page-head" }, h("span", { class: "page-title", text: title }), badge, h("div", { class: "page-tools" }, tools));
}

function toolBtn(iconName, label, onclick) {
  return h("button", { type: "button", class: "icon-btn flat", "aria-label": label, title: label, onclick }, icon(iconName));
}

function createCanvasPage(doc, idx) {
  const canvas = h("canvas");
  const textLayer = h("div", { class: "text-layer" });
  const hlLayer = h("div", { class: "hl-layer" });
  const innerEl = h("div", { class: "page-inner" }, canvas, textLayer, hlLayer, h("div", { class: "scan-beam" }));
  const pageEl = h("div", { class: "page scanning" }, innerEl);
  const badge = h("span", { class: "badge working", text: "Waiting" });
  const entry = { kind: "canvas", idx, canvas, textLayer, hlLayer, innerEl, pageEl, badge, words: [], source: null, busy: false, rotation: 0, spans: [], hlGroups: [], hitCount: 0 };
  const tools = [
    toolBtn("rotate", "Rotate this page", () => rotatePage(doc, idx)),
    toolBtn("retry", "Read this page again with OCR", () => rereadPage(doc, idx)),
    toolBtn("translate", "Translate this page", () => translatePageClick(doc, idx)),
  ];
  entry.wrap = h("div", { class: "page-wrap", "data-page": String(idx + 1) }, pageHead(`Page ${idx + 1}`, badge, tools), pageEl);
  doc.el.append(entry.wrap);
  return entry;
}

function createTextPage(doc, idx, data) {
  const body = h("div", { class: "text-sheet" });
  const entry = { kind: "text", idx, body, title: data.title, blocks: data.blocks, text: data.text, source: "text", hitCount: 0, marks: [] };
  const badge = h("span", { class: "badge native", text: doc.info.label });
  entry.wrap = h(
    "div",
    { class: "page-wrap", "data-page": String(idx + 1) },
    pageHead(data.title || `Page ${idx + 1}`, badge, [toolBtn("translate", "Translate this page", () => translatePageClick(doc, idx))]),
    body
  );
  doc.el.append(entry.wrap);
  renderTextBody(entry, "", 0);
  return entry;
}

function setBadge(entry, kind, text, title) {
  entry.badge.className = `badge ${kind}`;
  entry.badge.textContent = text;
  entry.badge.title = title || "";
}

function fitPage(entry) {
  if (entry.kind !== "canvas" || !entry.canvas.width) return;
  const avail = Math.max(240, benchEl.clientWidth - (window.innerWidth <= 900 ? 20 : 48));
  const target = Math.min(avail, MAX_DISPLAY_WIDTH) * state.zoom;
  const scale = Math.min(2, target / entry.canvas.width);
  const w = entry.canvas.width * scale;
  const hgt = entry.canvas.height * scale;
  entry.wrap.style.width = `${w}px`;
  entry.wrap.style.maxWidth = "none";
  entry.pageEl.style.width = `${w}px`;
  entry.pageEl.style.height = `${hgt}px`;
  entry.innerEl.style.width = `${entry.canvas.width}px`;
  entry.innerEl.style.height = `${entry.canvas.height}px`;
  entry.innerEl.style.transform = `scale(${scale})`;
}

function fitAllPages(doc) {
  benchEl.style.setProperty("--zoom", String(state.zoom));
  doc.el.style.setProperty("--zoom", String(state.zoom));
  for (const p of doc.pages) fitPage(p);
}

// ---------- text pages ----------

function textUnits(entry) {
  const units = [];
  for (const b of entry.blocks) {
    if (b.t === "table") for (const row of b.rows) for (const cell of row) units.push(cell);
    else units.push(b.text || "");
  }
  return units;
}

function appendMarked(parent, text, query, counter) {
  text = String(text ?? "").normalize("NFC"); // offsets from the search are computed on NFC text
  const occ = query ? findTextOccurrences(text, query) : [];
  if (!occ.length) {
    parent.append(text);
    return;
  }
  let pos = 0;
  for (const o of occ) {
    if (o.index > pos) parent.append(text.slice(pos, o.index));
    const mark = h("mark", { class: "hit", text: text.slice(o.index, o.index + o.length) });
    mark.dataset.local = String(counter.n++);
    parent.append(mark);
    pos = o.index + o.length;
  }
  if (pos < text.length) parent.append(text.slice(pos));
}

function renderTextBody(entry, query) {
  const counter = { n: 0 };
  const nodes = [];
  for (const b of entry.blocks) {
    if (b.t === "h") {
      const n = h("h3", { class: `h${b.level || 1}` });
      appendMarked(n, b.text, query, counter);
      nodes.push(n);
    } else if (b.t === "code") {
      const n = h("pre");
      appendMarked(n, b.text, query, counter);
      nodes.push(n);
    } else if (b.t === "table") {
      const tbody = h("tbody");
      for (const row of b.rows) {
        const tr = h("tr");
        for (const cell of row) {
          const td = h("td");
          appendMarked(td, cell, query, counter);
          tr.append(td);
        }
        tbody.append(tr);
      }
      nodes.push(h("div", { style: "overflow-x:auto" }, h("table", {}, tbody)));
    } else {
      const n = h("p");
      appendMarked(n, b.text, query, counter);
      nodes.push(n);
    }
  }
  entry.body.replaceChildren(...nodes);
  entry.marks = Array.from(entry.body.querySelectorAll("mark.hit"));
}

// ---------- processing queue ----------

const ocrQueue = [];
let queueRunning = false;

async function pumpQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (ocrQueue.length) {
      const doc = ocrQueue.shift();
      if (doc.closed) continue;
      try {
        await processVisualDoc(doc);
      } catch (err) {
        failDoc(doc, err);
      }
    }
  } finally {
    queueRunning = false;
  }
}

function progress(doc, done, total) {
  doc.done = done;
  doc.total = total;
  refreshTrayItem(doc);
}

function narrate(doc, text) {
  if (doc.id === state.activeId) setStatus(text);
}

async function processTextDoc(doc) {
  doc.status = "processing";
  refreshTrayItem(doc);
  const pages = await loadTextPages(doc.file, doc.info);
  if (doc.closed) return;
  pages.forEach((p, i) => doc.pages.push(createTextPage(doc, i, p)));
  doc.status = "done";
  progress(doc, pages.length, pages.length);
  fitAllPages(doc);
  if (state.query) runSearch(state.query, { keepActive: true });
  if (doc.id === state.activeId) {
    setStatus(`Opened ${doc.name}.`, { ms: 2500 });
    renderDrawer();
  }
}

// A document keeps the reading languages it was opened with, so its cache key always
// matches what was actually recognised, even if Settings change while it is processing.
const docLangs = (doc) => doc.ocrLangs || state.settings.ocrLangs;

const ocrOpts = (doc) => ({
  langs: docLangs(doc),
  enhance: !doc.info.kind.startsWith("pdf") && state.settings.enhance,
  onStatus: (t) => narrate(doc, t),
});

async function processVisualDoc(doc) {
  doc.status = "processing";
  refreshTrayItem(doc);
  narrate(doc, `Opening ${doc.name}…`);

  const buf = await doc.file.arrayBuffer();
  doc.hash = await hashBuffer(buf);
  doc.ocrLangs = state.settings.ocrLangs.slice();
  doc.cacheKey = docCacheKey(doc.hash, doc.ocrLangs);
  const cached = await getCachedDoc(doc.cacheKey);
  if (doc.closed) return;

  let canvases = null;
  let total;
  if (doc.info.kind === "pdf") {
    try {
      doc.pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    } catch (err) {
      console.error("ScanText: failed to open PDF", err);
      throw new Error("Couldn't open this PDF — it may be encrypted or damaged.");
    }
    total = doc.pdf.numPages;
    if (total > MANY_PAGES) narrate(doc, `${doc.name} has ${total} pages. Large scanned files can take a while and a lot of memory.`);
  } else {
    canvases = await decodeImagePages(doc.file, doc.info);
    total = canvases.length;
  }
  if (doc.closed) return;

  for (let i = 0; i < total; i++) doc.pages.push(createCanvasPage(doc, i));
  if (canvases) {
    canvases.forEach((src, i) => {
      const e = doc.pages[i];
      e.canvas.width = src.width;
      e.canvas.height = src.height;
      e.canvas.getContext("2d").drawImage(src, 0, 0);
      const turns = (cached && cached.pages && cached.pages[i] && cached.pages[i].turns) || 0;
      for (let t = 0; t < turns; t++) rotateCanvas90(e.canvas); // restore a rotation saved with the cache
      e.turns = turns % 4;
      fitPage(e);
    });
  } else {
    doc.pages.forEach((e, i) => {
      const saved = cached && cached.pages && cached.pages[i];
      if (saved && saved.rot) e.rotation = saved.rot;
    });
  }
  progress(doc, 0, total);
  if (doc.id === state.activeId) renderDrawer();

  let failures = 0;
  let usedOcr = false;
  for (let i = 0; i < total; i++) {
    if (doc.closed) return;
    narrate(doc, total > 1 ? `Reading page ${i + 1} of ${total}…` : `Reading ${doc.name}…`);
    try {
      await readPage(doc, i, { cachedPage: cached && cached.pages && cached.pages[i] });
      if (doc.pages[i].source === "ocr") usedOcr = true;
    } catch (err) {
      console.error(`ScanText: failed on page ${i + 1} of ${doc.name}`, err);
      failures++;
      markPageFailed(doc.pages[i], err);
    }
    progress(doc, i + 1, total);
    searchAfterPage(doc, doc.pages[i]);
  }

  if (doc.closed) return;
  doc.status = "done";
  await saveDocCache(doc);
  refreshTrayItem(doc);
  if (doc.id === state.activeId) {
    renderDrawer();
    if (failures) {
      setStatus(`${plural(failures, "page")} couldn't be read. Use the retry button above ${failures === 1 ? "it" : "each"} to try again.`, { warn: true });
    } else setStatus(usedOcr ? `Done. ${plural(total, "page")} read.` : `Done. ${plural(total, "page")} opened.`, { ms: 4000 });
  }
}

async function saveDocCache(doc) {
  if (!doc.cacheKey) return;
  // Only cache a complete read: every page recognised, none failed, none still queued.
  if (doc.pages.some((p) => p.failed || !p.source || p.busy)) return;
  await saveCachedDoc(doc.cacheKey, {
    pages: doc.pages.map((p) => ({ words: p.words, source: p.source, rot: p.rotation || 0, turns: p.turns || 0 })),
    savedAt: Date.now(),
  });
}

function markPageFailed(entry, err) {
  entry.failed = true;
  entry.pageEl.classList.remove("scanning");
  setBadge(entry, "fail", "Couldn't read", errorMessage(err));
}

function scaleForPdfPage(viewport1) {
  const long = Math.max(viewport1.width, viewport1.height);
  return Math.max(1, Math.min(RENDER_SCALE, MAX_CANVAS_DIM / long));
}

// Native text must look like words before we trust it: some PDFs carry a text layer
// that decodes to control or private-use characters, and indexing that is worse than
// running OCR.
function looksLikeRealText(words) {
  if (!words.length) return false;
  const sample = words.map((w) => w.text).join("");
  // Count anything letter-like in any script as "real" — a Hindi PDF isn't ASCII.
  // \p{M} matters: vowel signs and matras in Devanagari, Bengali, Tamil, Thai… are marks.
  const real = sample.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S}]/gu, "").length;
  const privateUse = (sample.match(/[-�]/g) || []).length;
  return real / sample.length > 0.85 && privateUse / sample.length < 0.1;
}

async function runOcr(doc, entry, label) {
  entry.pageEl.classList.add("scanning");
  setBadge(entry, "working", "Reading…");
  await prepareOcr(docLangs(doc), (t) => narrate(doc, t));
  try {
    return await withTimeout(ocrCanvas(entry.canvas, ocrOpts(doc)), OCR_TIMEOUT_MS, `OCR timed out on ${label}`);
  } catch (err) {
    // A timed-out job keeps running inside the worker and would stall every page after it.
    if (/timed out/.test(String(err && err.message))) await resetWorker();
    throw err;
  }
}

// Renders (PDF) or reuses (image) the page canvas and fills entry.words / entry.source.
async function readPage(doc, idx, { cachedPage = null, forceOcr = false } = {}) {
  const entry = doc.pages[idx];
  entry.busy = true;
  entry.failed = false;
  try {
    let page = null;
    let viewport = null;
    if (doc.pdf) {
      page = await doc.pdf.getPage(idx + 1);
      const rotation = (((page.rotate || 0) + entry.rotation) % 360 + 360) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      viewport = page.getViewport({ scale: scaleForPdfPage(base), rotation });
      entry.canvas.width = viewport.width;
      entry.canvas.height = viewport.height;
      fitPage(entry);
      await page.render({ canvasContext: entry.canvas.getContext("2d"), viewport }).promise;
    }

    let words;
    let source;
    const label = `page ${idx + 1}`;
    if (cachedPage && !forceOcr) {
      words = cachedPage.words;
      source = cachedPage.source;
    } else if (forceOcr || !doc.pdf) {
      words = await runOcr(doc, entry, label);
      source = "ocr";
    } else {
      const native = wordsFromTextContent(await page.getTextContent(), viewport);
      const chars = native.reduce((n, w) => n + w.text.length, 0);
      const scrambled = hasBrokenShaping(native);
      const ocrConfigured = docLangs(doc).some((l) => l !== "eng");
      if (chars >= MIN_NATIVE_CHARS && looksLikeRealText(native) && !(scrambled && ocrConfigured)) {
        words = native;
        source = "text";
        if (scrambled) {
          narrate(doc, `Page ${idx + 1} has a text layer that splits Indian-script words apart, so search may miss some. Add the language in Settings to read it with OCR instead.`);
        }
      } else {
        narrate(doc, `Page ${idx + 1} looks like a scan. Reading it with OCR…`);
        words = await runOcr(doc, entry, label);
        source = "ocr";
      }
    }

    entry.words = words;
    entry.source = source;
    entry.pageEl.classList.remove("scanning");
    setBadge(entry, source === "ocr" ? "ocr" : "native", source === "ocr" ? "Read by OCR" : "Text layer", source === "ocr" ? "Recognised from the page image" : "Text already inside the PDF");
    buildTextLayer(entry);
  } finally {
    entry.busy = false;
  }
}

async function rereadPage(doc, idx) {
  const entry = doc.pages[idx];
  if (!entry || entry.busy) return;
  try {
    await readPage(doc, idx, { forceOcr: true });
    await saveDocCache(doc);
    runSearch(state.query, { keepActive: true });
    refreshTrayItem(doc);
    setStatus(`Page ${idx + 1} read again.`, { ms: 2500 });
  } catch (err) {
    console.error("ScanText: re-read failed", err);
    markPageFailed(entry, err);
  }
}

function rotateCanvas90(canvas) {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext("2d").drawImage(canvas, 0, 0);
  canvas.width = copy.height;
  canvas.height = copy.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(copy, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

async function rotatePage(doc, idx) {
  const entry = doc.pages[idx];
  if (!entry || entry.busy) return;
  const hadOcr = entry.source === "ocr" || !doc.pdf;
  entry.busy = true;
  try {
    if (doc.pdf) {
      entry.rotation = (entry.rotation + 90) % 360;
    } else {
      rotateCanvas90(entry.canvas);
      entry.turns = ((entry.turns || 0) + 1) % 4;
      fitPage(entry);
    }
  } finally {
    entry.busy = false;
  }
  try {
    if (doc.pdf) await readPage(doc, idx, { forceOcr: hadOcr });
    else await readPage(doc, idx, { forceOcr: true, skipRender: true });
    await saveDocCache(doc);
    runSearch(state.query, { keepActive: true });
  } catch (err) {
    markPageFailed(entry, err);
  }
}

// ---------- native text extraction & text layer (ported from the extension) ----------

// pdf.js yields text runs, not word boxes; split each run into words and share its width
// by character offset. Exact enough for highlighting and selection.
function wordsFromTextContent(textContent, viewport) {
  const words = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(m[0], m[1]) || Math.hypot(m[2], m[3]) || 10;
    const originX = m[4];
    const baselineY = m[5];
    const widthPx = (item.width || 0) * viewport.scale;
    const y0 = baselineY - fontHeight * 0.85;
    const y1 = baselineY + fontHeight * 0.25;
    const totalLen = item.str.length || 1;
    let offset = 0;
    for (const part of item.str.split(/(\s+)/)) {
      if (part.trim().length > 0) {
        words.push({
          text: part,
          x0: originX + (offset / totalLen) * widthPx,
          x1: originX + ((offset + part.length) / totalLen) * widthPx,
          y0,
          y1,
        });
      }
      offset += part.length;
    }
  }
  return words;
}

const measureCtx = document.createElement("canvas").getContext("2d");

// Canvas pixels aren't selectable, so each word gets an invisible span at its exact
// position (same idea as pdf.js's own text layer). Selection and copy then just work.
function buildTextLayer(entry) {
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const w of entry.words) {
    if (!w.text || !w.text.trim()) continue;
    if (prev && !isSameLine(prev, w)) frag.append(document.createElement("br"));
    const targetWidth = Math.max(2, w.x1 - w.x0);
    const targetHeight = Math.max(6, w.y1 - w.y0);
    const fontSize = targetHeight * 0.85;
    measureCtx.font = `${fontSize}px sans-serif`;
    const natural = measureCtx.measureText(w.text).width || 1;
    const span = document.createElement("span");
    span.textContent = w.text + " ";
    span.style.cssText = `left:${w.x0}px;top:${w.y0}px;font-size:${fontSize}px;line-height:${targetHeight}px;transform:scaleX(${targetWidth / natural})`;
    frag.append(span);
    prev = w;
  }
  entry.textLayer.replaceChildren(frag);
}

// ---------- search ----------

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInput.value, { fresh: true }), 120);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    searchInput.value = "";
    runSearch("", { fresh: true });
    searchInput.blur();
  }
});
$("nextBtn").addEventListener("click", () => stepMatch(1));
$("prevBtn").addEventListener("click", () => stepMatch(-1));

function countPageHits(entry, q) {
  if (!q) {
    entry.spans = [];
    entry.hitCount = 0;
    return;
  }
  if (entry.kind === "canvas") {
    entry.spans = findWordMatches(entry.words, q);
    entry.hitCount = entry.spans.length;
  } else {
    entry.hitCount = textUnits(entry).reduce((n, u) => n + findTextOccurrences(u, q).length, 0);
  }
}

function recount(doc, q) {
  doc.hitTotal = 0;
  for (const p of doc.pages) {
    countPageHits(p, q);
    doc.hitTotal += p.hitCount;
  }
}

function locateHit(doc, idx) {
  let n = idx;
  for (const p of doc.pages) {
    if (n < p.hitCount) return { entry: p, local: n };
    n -= p.hitCount;
  }
  return null;
}

// One highlight rectangle per line of a matched span (a phrase can wrap).
function spanRects(words, span) {
  const rects = [];
  let cur = null;
  let prev = null;
  for (let i = span.start; i <= span.end; i++) {
    const w = words[i];
    if (cur && prev && isSameLine(prev, w)) {
      cur.x0 = Math.min(cur.x0, w.x0);
      cur.x1 = Math.max(cur.x1, w.x1);
      cur.y0 = Math.min(cur.y0, w.y0);
      cur.y1 = Math.max(cur.y1, w.y1);
    } else {
      cur = { x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 };
      rects.push(cur);
    }
    prev = w;
  }
  return rects;
}

function paintPage(entry, q) {
  if (entry.kind === "canvas") {
    const frag = document.createDocumentFragment();
    entry.hlGroups = entry.spans.map((span) =>
      spanRects(entry.words, span).map((r) => {
        const d = h("div", { class: "hl" });
        d.style.cssText = `left:${r.x0 - 2}px;top:${r.y0}px;width:${r.x1 - r.x0 + 4}px;height:${r.y1 - r.y0}px`;
        frag.append(d);
        return d;
      })
    );
    entry.hlLayer.replaceChildren(frag);
  } else {
    renderTextBody(entry, q);
  }
}

function paintDoc(doc, q) {
  for (const p of doc.pages) paintPage(p, q);
}

function clearActive(doc) {
  doc.el.querySelectorAll(".hl.active, mark.hit.active").forEach((n) => n.classList.remove("active"));
}

function focusHit(doc, idx, scroll) {
  clearActive(doc);
  state.activeHit = idx;
  const loc = idx >= 0 ? locateHit(doc, idx) : null;
  if (loc) {
    const els = loc.entry.kind === "canvas" ? loc.entry.hlGroups[loc.local] : [loc.entry.marks[loc.local]];
    (els || []).filter(Boolean).forEach((n) => n.classList.add("active"));
    if (scroll && els && els[0]) els[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }
  updateMatchLabel();
}

function runSearch(query, { fresh = false, keepActive = false } = {}) {
  const q = (query || "").trim();
  state.query = q;
  for (const d of state.docs) recount(d, q);
  const doc = activeDoc();
  if (doc) {
    paintDoc(doc, q);
    let idx = -1;
    if (doc.hitTotal) idx = keepActive && state.activeHit >= 0 && state.activeHit < doc.hitTotal ? state.activeHit : 0;
    focusHit(doc, idx, fresh && idx >= 0);
  } else updateMatchLabel();
  refreshAllTray();
}

// During processing, only the newly finished page changes — repaint just that one.
function searchAfterPage(doc, entry) {
  if (!state.query) return;
  recount(doc, state.query);
  if (doc.id === state.activeId) {
    paintPage(entry, state.query);
    const keep = state.activeHit >= 0 && state.activeHit < doc.hitTotal ? state.activeHit : doc.hitTotal ? 0 : -1;
    focusHit(doc, keep, false);
  }
  refreshTrayItem(doc);
}

function stepMatch(dir) {
  const doc = activeDoc();
  if (!doc || !state.query) return;
  const total = doc.hitTotal;
  const next = state.activeHit + dir;
  if (total && next >= 0 && next < total) return focusHit(doc, next, true);

  // Past the end of this document: continue into the next one that has matches.
  const order = state.docs;
  const start = order.indexOf(doc);
  for (let step = 1; step <= order.length; step++) {
    const cand = order[(start + dir * step + order.length * step) % order.length];
    if (cand.hitTotal) {
      if (cand !== doc) {
        selectDoc(cand.id);
        focusHit(cand, dir > 0 ? 0 : cand.hitTotal - 1, true);
      } else focusHit(doc, dir > 0 ? 0 : total - 1, true);
      return;
    }
  }
}

function updateMatchLabel() {
  const doc = activeDoc();
  if (!state.query) matchLabel.textContent = "";
  else if (!doc || !doc.hitTotal) {
    const others = state.docs.reduce((n, d) => n + d.hitTotal, 0);
    matchLabel.textContent = others ? `0 here, ${others} elsewhere` : "No matches";
  } else matchLabel.textContent = `${state.activeHit + 1} of ${doc.hitTotal}`;
}

// ---------- zoom & page indicator ----------

function setZoom(z) {
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
  $("zoomFit").textContent = `${Math.round(state.zoom * 100)}%`;
  state.docs.forEach(fitAllPages);
}

$("zoomIn").addEventListener("click", () => setZoom(state.zoom + 0.15));
$("zoomOut").addEventListener("click", () => setZoom(state.zoom - 0.15));
$("zoomFit").addEventListener("click", () => setZoom(1));

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.docs.forEach(fitAllPages), 120);
});

let scrollRaf = 0;
benchEl.addEventListener("scroll", () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(updatePageIndicator);
});

function updatePageIndicator() {
  const doc = activeDoc();
  if (!doc || !doc.pages.length) return;
  const top = benchEl.getBoundingClientRect().top + 90;
  let current = 1;
  for (const p of doc.pages) {
    const r = p.wrap.getBoundingClientRect();
    if (r.bottom > top) {
      current = p.idx + 1;
      break;
    }
    current = p.idx + 1;
  }
  $("pageIndicator").textContent = doc.info.kind === "xlsx" || doc.info.kind === "pptx" ? `Part ${current} of ${doc.pages.length}` : `Page ${current} of ${doc.pages.length}`;
}

// ---------- selection bar (copy / translate) ----------

const selectionBar = h(
  "div",
  { class: "selection-bar", role: "toolbar", "aria-label": "Selected text", hidden: true },
  h("button", { type: "button", "data-sel": "copy" }, icon("copy"), h("span", { text: "Copy" })),
  h("button", { type: "button", "data-sel": "translate" }, icon("translate"), h("span", { text: "Translate" }))
);
document.body.append(selectionBar);

let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(updateSelectionBar, 160);
});
document.addEventListener("mouseup", () => {
  clearTimeout(selTimer);
  setTimeout(updateSelectionBar, 0);
});
document.addEventListener("mousedown", (e) => {
  if (!selectionBar.contains(e.target)) selectionBar.hidden = true;
});
selectionBar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive

function selectionInDocument() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el || !el.closest(".text-layer, .text-sheet")) return null;
  return { text: sel.toString(), rect: range.getBoundingClientRect() };
}

function updateSelectionBar() {
  const s = selectionInDocument();
  if (!s || (!s.rect.width && !s.rect.height)) {
    selectionBar.hidden = true;
    return;
  }
  selectionBar.hidden = false;
  const bw = selectionBar.offsetWidth;
  const bh = selectionBar.offsetHeight;
  const top = s.rect.top - bh - 8 < 8 ? s.rect.bottom + 8 : s.rect.top - bh - 8;
  const left = Math.min(Math.max(8, s.rect.left + s.rect.width / 2 - bw / 2), window.innerWidth - bw - 8);
  selectionBar.style.top = `${top}px`;
  selectionBar.style.left = `${left}px`;
}

selectionBar.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const s = selectionInDocument();
  if (!s) return;
  if (btn.dataset.sel === "copy") {
    try {
      await navigator.clipboard.writeText(s.text);
      btn.querySelector("span").textContent = "Copied";
      setTimeout(() => {
        selectionBar.hidden = true;
        btn.querySelector("span").textContent = "Copy";
      }, 800);
    } catch {
      setStatus("Couldn't copy to the clipboard.", { warn: true, ms: 4000 });
    }
  } else {
    selectionBar.hidden = true;
    openDrawer();
    translateSelection(s.text);
  }
});

// ---------- translate drawer ----------

const drawerEl = $("drawer");
const srcSel = $("srcLang");
const tgtSel = $("tgtLang");

function buildLangSelects() {
  srcSel.replaceChildren(h("option", { value: "auto", text: "Auto-detect" }));
  for (const l of TRANSLATE_LANGS) {
    srcSel.append(h("option", { value: l.code, text: l.native && l.native !== l.name ? `${l.name} (${l.native})` : l.name }));
    tgtSel.append(h("option", { value: l.code, text: l.native && l.native !== l.name ? `${l.name} (${l.native})` : l.name }));
  }
  tgtSel.value = state.settings.targetLang || "";
}

function openDrawer() {
  appEl.dataset.drawer = "open";
  drawerEl.inert = false;
  translateBtn.setAttribute("aria-expanded", "true");
  renderDrawer();
  ensureDetected(activeDoc());
  refreshEngineNote();
}

function closeDrawer() {
  appEl.dataset.drawer = "closed";
  drawerEl.inert = true;
  translateBtn.setAttribute("aria-expanded", "false");
}

translateBtn.addEventListener("click", () => (appEl.dataset.drawer === "open" ? closeDrawer() : openDrawer()));
$("drawerClose").addEventListener("click", () => {
  closeDrawer();
  translateBtn.focus();
});
tgtSel.addEventListener("change", async () => {
  state.settings.targetLang = tgtSel.value;
  await setSetting("targetLang", tgtSel.value);
  renderDrawer();
  refreshEngineNote();
});
srcSel.addEventListener("change", () => {
  renderDrawer();
  refreshEngineNote();
});

const trFor = (doc, lang = state.settings.targetLang) => doc && doc.tr.byLang[lang];

async function ensureDetected(doc) {
  if (!doc) return null;
  const sample = doc.pages.map(docPageText).filter(Boolean).join("\n").slice(0, 4000);
  if (!sample.trim()) return null;
  const hints = ocrHints(state.settings.ocrLangs);
  doc.srcDetected = await detectSource(sample, hints);
  const opt = srcSel.querySelector('option[value="auto"]');
  if (opt && doc.id === state.activeId) opt.textContent = `Auto-detect (${langName(doc.srcDetected.code)})`;
  return doc.srcDetected;
}

async function resolveSource(doc, sampleText) {
  if (srcSel.value !== "auto") return srcSel.value;
  const hints = ocrHints(state.settings.ocrLangs);
  const found = await detectSource(sampleText, hints);
  if (doc) doc.srcDetected = found;
  const opt = srcSel.querySelector('option[value="auto"]');
  if (opt) opt.textContent = `Auto-detect (${langName(found.code)})`;
  return found.code;
}

function engineConfig() {
  const s = state.settings;
  return {
    myMemoryEmail: s.myMemoryEmail,
    libreUrl: s.libreUrl,
    libreKey: s.libreKey,
    onDownload: (frac) => setTrStatus(`Downloading the language pack, ${Math.round(frac * 100)}%…`),
  };
}

async function refreshEngineNote() {
  const note = $("engineNote");
  const doc = activeDoc();
  const src = srcSel.value !== "auto" ? srcSel.value : doc && doc.srcDetected ? doc.srcDetected.code : "en";
  if (!tgtSel.value) {
    note.textContent = "Choose a language to translate into.";
    note.classList.remove("is-online");
    return;
  }
  try {
    const engine = await pickEngine(state.settings.engine, src, tgtSel.value, engineConfig());
    note.textContent = describeEngine(engine, engineConfig());
    note.classList.toggle("is-online", engine.online);
  } catch (err) {
    note.textContent = errorMessage(err);
    note.classList.add("is-online");
  }
}

function setTrStatus(text) {
  const el = $("trError");
  el.hidden = true;
  setStatus(text);
}

function showTrError(text) {
  const el = $("trError");
  el.textContent = text;
  el.hidden = !text;
}

function setTrProgress(frac) {
  const bar = $("trProgress");
  bar.hidden = frac == null;
  if (frac != null) bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

function renderDrawer() {
  const doc = activeDoc();
  const list = $("trPages");
  list.replaceChildren();
  $("translateDocBtn").disabled = !doc || !doc.pages.length;
  const trNow = doc && trFor(doc);
  const doneCount = trNow ? trNow.pages.filter(Boolean).length : 0;
  $("translateDocBtn").textContent = !doneCount ? "Translate document" : doneCount < (doc ? doc.pages.length : 0) ? "Translate the rest" : "Translate again";
  $("stopBtn").hidden = !(doc && doc.tr.running);
  showTrError(doc ? doc.tr.error || "" : "");
  if (!doc) return;
  const tr = trFor(doc);
  const tgt = state.settings.targetLang;
  doc.pages.forEach((p, i) => list.append(buildTrCard(doc, p, i, tr, tgt)));
  const done = tr ? tr.pages.filter(Boolean).length : 0;
  $("translatedLabel").textContent = done ? `Translation to ${langName(tgt)}` : "Translation (translate first)";
  document.querySelectorAll("#translatedGroup button").forEach((b) => b.classList.toggle("is-off", !done));
}

function buildTrCard(doc, page, i, tr, tgt) {
  const text = tr && tr.pages[i];
  const original = docPageText(page) || "";
  const working = doc.tr.workingIdx === i;
  const title = page.title || `Page ${i + 1}`;
  const body = h("div", { class: "tr-body", dir: "auto", lang: tgt });
  if (text) body.textContent = text;
  else if (working) {
    body.classList.add("is-working");
    body.textContent = "Translating…";
  } else if (!original.trim()) {
    body.classList.add("is-empty");
    body.textContent = "No text on this page.";
  } else {
    body.classList.add("is-empty");
    body.removeAttribute("dir");
    body.append("Not translated yet.", h("span", { class: "tr-snippet", text: original.replace(/\s+/g, " ").slice(0, 120) }));
  }
  const actions = [];
  if (text) actions.push(h("button", { type: "button", class: "btn small", onclick: () => copyText(text, "Translation copied.") }, icon("copy"), h("span", { text: "Copy" })));
  if (original.trim()) {
    actions.push(
      h("button", { type: "button", class: "btn small", disabled: doc.tr.running, onclick: () => translatePageClick(doc, i) }, h("span", { text: text ? "Redo" : "Translate" }))
    );
  }
  return h(
    "div",
    { class: "tr-card", "data-card": String(i) },
    h("div", { class: "tr-card-head" }, h("button", { type: "button", class: "tr-card-title", onclick: () => scrollToPage(doc, i), text: title }), actions),
    body
  );
}

function scrollToPage(doc, i) {
  const p = doc.pages[i];
  if (p) p.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(okMessage, { ms: 2500 });
  } catch {
    setStatus("Couldn't copy to the clipboard.", { warn: true, ms: 4000 });
  }
}

// consent for online engines
const consentPanel = $("consentPanel");
let consentResolve = null;

function consentKey(engine, cfg) {
  // For a LibreTranslate server the origin (https vs http, port) is part of what was agreed to.
  if (engine.id === "libre") {
    try {
      return `libre:${new URL(cfg.libreUrl).origin}`;
    } catch {
      /* fall through to the host-based key */
    }
  }
  return `${engine.id}:${engineHost(engine, cfg)}`;
}

function askConsent(engine, cfg, scopeText) {
  return new Promise((resolve) => {
    if (consentResolve) consentResolve(false); // never leave an earlier prompt hanging
    consentResolve = resolve;
    $("consentBody").textContent = `${engine.label} will receive ${scopeText}. Nothing else from your document is sent, and your files and images stay in this browser.${engine.id === "mymemory" && cfg.myMemoryEmail ? " The email address from Settings is sent along too." : ""} Online translators can keep copies of what they receive, so don't send anything confidential.`;
    $("consentYes").textContent = `Send to ${engineHost(engine, cfg)}`;
    consentPanel.hidden = false;
    returnFocusTo = document.activeElement;
    $("consentYes").focus();
  });
}

function settleConsent(ok) {
  consentPanel.hidden = true;
  restoreFocus();
  if (consentResolve) consentResolve(ok);
  consentResolve = null;
}
$("consentYes").addEventListener("click", () => settleConsent(true));
$("consentNo").addEventListener("click", () => settleConsent(false));
consentPanel.addEventListener("click", (e) => {
  if (e.target === consentPanel) settleConsent(false);
});

// Shared set-up for translating anything: choose languages and engine, get consent,
// and (for Chrome) create the translator while the click's user activation is still live.
async function prepareTranslation(doc, sampleText, scopeText) {
  const tgt = tgtSel.value;
  const src = await resolveSource(doc, sampleText);
  if (src === tgt) {
    throw new TranslateError(`This already looks like ${langName(src)}. Choose a different language in “To”, or set “From” yourself if the detection is wrong.`, "config");
  }
  const cfg = engineConfig();
  const engine = await pickEngine(state.settings.engine, src, tgt, cfg);
  if (engine.online) {
    const key = consentKey(engine, cfg);
    if (!state.settings.consent[key]) {
      const ok = await askConsent(engine, cfg, scopeText);
      if (!ok) throw new TranslateError("Translation cancelled.", "cancelled");
      state.settings.consent[key] = true;
      await setSetting("consent", state.settings.consent);
    }
  } else if (engine.prepare) {
    setTrStatus("Preparing the on-device translator…");
    await engine.prepare(src, tgt, cfg);
  }
  refreshEngineNote();
  return { src, tgt, engine, cfg };
}

function translatePageClick(doc, idx) {
  if (doc.id !== state.activeId) selectDoc(doc.id);
  openDrawer();
  runTranslate(doc, [idx]);
}

$("translateDocBtn").addEventListener("click", () => {
  const doc = activeDoc();
  if (!doc) return;
  const tr = trFor(doc);
  const todo = doc.pages.map((_, i) => i).filter((i) => !(tr && tr.pages[i]));
  runTranslate(doc, todo.length ? todo : doc.pages.map((_, i) => i));
});

$("stopBtn").addEventListener("click", () => {
  const doc = activeDoc();
  if (doc && doc.tr.ctl) doc.tr.ctl.abort();
});

async function runTranslate(doc, indices) {
  if (doc.tr.running || doc.tr.preparing) return;
  const withText = indices.filter((i) => (docPageText(doc.pages[i]) || "").trim());
  if (!withText.length) {
    showTrError("There's no text to translate yet. If the document is still being read, wait for it to finish.");
    return;
  }
  doc.tr.error = null;
  showTrError("");
  const tgt = tgtSel.value;
  if (!tgt) {
    doc.tr.error = "Choose the language to translate into first.";
    showTrError(doc.tr.error);
    tgtSel.focus();
    return;
  }
  const sample = withText.map((i) => docPageText(doc.pages[i])).join("\n").slice(0, 4000);
  const scope = withText.length === 1 ? `the text of one page of “${doc.name}”` : `the text of ${doc.name}`;

  let ctx;
  doc.tr.preparing = true; // blocks a second click while detection/consent/language pack is pending
  try {
    ctx = await prepareTranslation(doc, sample, scope);
    doc.tr.preparing = false;
  } catch (err) {
    doc.tr.preparing = false;
    if (err.kind !== "cancelled") {
      doc.tr.error = errorMessage(err);
      showTrError(doc.tr.error);
    }
    setStatus("");
    return;
  }

  const ctl = new AbortController();
  doc.tr.ctl = ctl;
  doc.tr.running = true;
  if (!doc.tr.byLang[tgt]) doc.tr.byLang[tgt] = { src: ctx.src, engine: ctx.engine.label, pages: [] };
  const store = doc.tr.byLang[tgt];
  store.src = ctx.src;
  store.engine = ctx.engine.label;
  $("stopBtn").hidden = false;
  $("translateDocBtn").disabled = true;
  setTrProgress(0);

  let finished = 0;
  try {
    for (const i of withText) {
      if (ctl.signal.aborted || doc.closed) break;
      doc.tr.workingIdx = i;
      updateTrCard(doc, i);
      setStatus(`Translating ${doc.name}, ${withText.length === 1 ? "page " + (i + 1) : `${finished + 1} of ${withText.length}`}…`);
      store.pages[i] = await translateText(docPageText(doc.pages[i]), {
        engine: ctx.engine,
        src: ctx.src,
        tgt,
        cfg: ctx.cfg,
        signal: ctl.signal,
        cache: translationCache,
        onProgress: (d, t) => setTrProgress((finished + d / t) / withText.length),
      });
      finished++;
      doc.tr.workingIdx = null;
      updateTrCard(doc, i);
      refreshTrayItem(doc);
    }
    if (!ctl.signal.aborted) setStatus(`Translated ${plural(finished, "page")} to ${langName(tgt)}.`, { ms: 4000 });
    else setStatus(`Stopped. ${plural(finished, "page")} translated.`, { ms: 4000 });
  } catch (err) {
    if (err.kind === "cancelled") setStatus(`Stopped. ${plural(finished, "page")} translated.`, { ms: 4000 });
    else {
      console.error("ScanText: translation failed", err);
      doc.tr.error = `${errorMessage(err)}${finished ? ` ${plural(finished, "page")} finished before this; press Translate again to continue where it stopped.` : ""}`;
      setStatus("");
    }
  } finally {
    doc.tr.running = false;
    doc.tr.ctl = null;
    doc.tr.workingIdx = null;
    setTrProgress(null);
    if (doc.id === state.activeId) renderDrawer();
    refreshTrayItem(doc);
  }
}

function updateTrCard(doc, i) {
  if (doc.id !== state.activeId) return;
  const old = $("trPages").querySelector(`[data-card="${i}"]`);
  if (!old) return;
  const fresh = buildTrCard(doc, doc.pages[i], i, trFor(doc), state.settings.targetLang);
  old.replaceWith(fresh);
}

// translating a selection
async function translateSelection(text) {
  const card = $("selCard");
  card.hidden = false;
  $("selOriginal").textContent = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  const result = $("selResult");
  const copyBtn = $("selCopy");
  copyBtn.hidden = true;
  result.textContent = "Translating…";
  result.removeAttribute("lang");
  showTrError("");
  if (!tgtSel.value) {
    result.textContent = "";
    showTrError("Choose the language to translate into, then select the text again.");
    tgtSel.focus();
    return;
  }
  try {
    const ctx = await prepareTranslation(null, text, "the text you selected");
    result.setAttribute("lang", ctx.tgt);
    const out = await translateText(text, { engine: ctx.engine, src: ctx.src, tgt: ctx.tgt, cfg: ctx.cfg, cache: translationCache });
    result.textContent = out;
    copyBtn.hidden = false;
    copyBtn.onclick = () => copyText(out, "Translation copied.");
  } catch (err) {
    result.textContent = "";
    card.hidden = err.kind === "cancelled";
    if (err.kind !== "cancelled") showTrError(errorMessage(err));
    setStatus("");
  }
}
$("selClose").addEventListener("click", () => ($("selCard").hidden = true));

// ---------- export ----------

function exportModel(doc, lang = state.settings.targetLang) {
  const tr = trFor(doc, lang);
  const has = tr && tr.pages.some(Boolean);
  return {
    name: doc.stem,
    pages: doc.pages.map((p, i) => ({
      page: i + 1,
      title: p.kind === "text" ? p.title : null,
      source: p.source || "text",
      text: docPageText(p) || "",
      words: p.kind === "canvas" ? p.words : undefined,
      translation: has ? tr.pages[i] || null : null,
    })),
    translation: has ? { lang, langName: langName(lang), from: tr.src, engine: tr.engine } : null,
  };
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function allText(model, which) {
  return model.pages
    .map((p) => (which === "translation" ? p.translation : p.text))
    .filter(Boolean)
    .join("\n\n");
}

async function runExport(action) {
  const doc = activeDoc();
  if (!doc) return;
  const model = exportModel(doc);
  const wantsTranslation = action.endsWith("-tr");
  if (wantsTranslation && !model.translation) {
    openDrawer();
    showTrError("Translate the document first, then export the translation.");
    return;
  }
  const stem = wantsTranslation ? `${doc.stem}.${model.translation.lang}` : doc.stem;
  try {
    if (action === "copy") await copyText(allText(model, "original"), "All text copied.");
    else if (action === "copy-tr") await copyText(allText(model, "translation"), "Translation copied.");
    else if (action === "txt") downloadBlob(buildTxt(model), `${stem}.txt`, "text/plain;charset=utf-8");
    else if (action === "txt-tr") downloadBlob(buildTxt(model, "translation"), `${stem}.txt`, "text/plain;charset=utf-8");
    else if (action === "csv") downloadBlob(buildCsv(model), `${stem}.csv`, "text/csv;charset=utf-8");
    else if (action === "json") downloadBlob(buildJson(model), `${stem}.json`, "application/json");
    else if (action === "docx") downloadBlob(await buildDocxBlob(model, "original"), `${stem}.docx`);
    else if (action === "docx-tr") downloadBlob(await buildDocxBlob(model, "translation"), `${stem}.docx`);
    if (doc.status !== "done") setStatus("Exported what has been read so far. Export again when reading finishes.", { ms: 5000 });
  } catch (err) {
    console.error("ScanText: export failed", err);
    setStatus(`Export failed: ${errorMessage(err)}`, { warn: true });
  }
}

function closeMenu() {
  exportMenu.hidden = true;
  exportBtn.setAttribute("aria-expanded", "false");
}
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = exportMenu.hidden;
  exportMenu.hidden = !open;
  exportBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderDrawerExportState();
    exportMenu.querySelector("button").focus();
  }
});
function renderDrawerExportState() {
  const doc = activeDoc();
  const tr = doc && trFor(doc);
  const done = tr ? tr.pages.filter(Boolean).length : 0;
  $("translatedLabel").textContent = done ? `Translation to ${langName(state.settings.targetLang)}` : "Translation (translate first)";
  document.querySelectorAll("#translatedGroup button").forEach((b) => b.classList.toggle("is-off", !done));
}
exportMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  closeMenu();
  runExport(btn.dataset.action);
});
document.addEventListener("click", (e) => {
  if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) closeMenu();
});

// ---------- opening files: picker, camera, drop, paste, sample ----------

$("pickBtn").addEventListener("click", () => fileInput.click());
fileInput.accept = ACCEPT;
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});
cameraInput.addEventListener("change", () => {
  addFiles(cameraInput.files);
  cameraInput.value = "";
});
$("cameraBtn").addEventListener("click", () => cameraInput.click());
if (window.matchMedia("(pointer: coarse)").matches) $("cameraBtn").hidden = false;

let dragDepth = 0;
const veil = $("dropVeil");
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  veil.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) veil.hidden = true;
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  addFiles(e.dataTransfer.files);
});

window.addEventListener("paste", (e) => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  addFiles(files.map((f, i) => new File([f], `pasted-image-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.png`, { type: f.type, lastModified: Date.now() + i })));
});

// A small generated scan, so there's something to try before you have a file at hand.
$("sampleBtn").addEventListener("click", async () => {
  const W = 1500;
  const H = 1100;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f4f3ee";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-0.006);
  ctx.translate(-W / 2, -H / 2);
  ctx.fillStyle = "#1c1c1c";
  ctx.font = "700 54px Georgia, 'DejaVu Serif', serif";
  ctx.fillText("Ward Office Notice", 110, 150);
  ctx.font = "34px Georgia, 'DejaVu Serif', serif";
  const lines = [
    "The ward committee will meet on 14 March 2027 at 10:30",
    "in the main hall. The agenda covers the water supply,",
    "road repairs and the annual budget of 450000 rupees.",
    "",
    "Please bring the signed attendance register and one",
    "valid photo identity card. Questions can be sent to",
    "the clerk, Meena Rao, before the end of the month.",
  ];
  lines.forEach((l, i) => ctx.fillText(l, 110, 260 + i * 62));
  ctx.restore();
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  addFiles([new File([blob], "sample-notice.png", { type: "image/png", lastModified: Date.now() })]);
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === "Escape") {
    if (!consentPanel.hidden) settleConsent(false);
    else if (!settingsPanel.hidden) closeSettings();
    else if (!exportMenu.hidden) closeMenu();
    else selectionBar.hidden = true;
    return;
  }
  if (!state.docs.length) return;
  if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------- start ----------

async function init() {
  await loadSettings();
  // Optional: host the OCR language files yourself for fully offline use (see README).
  if (window.SCANTEXT_LANG_PATH) setLangPath(window.SCANTEXT_LANG_PATH);
  buildLangSelects();
  setZoom(1);
  if (window.matchMedia("(max-width: 540px)").matches) searchInput.placeholder = "Search";
  const params = new URLSearchParams(location.search);
  if (params.has("lang")) state.settings.targetLang = params.get("lang");
  window.__scantext = { state, addFiles }; // handy for debugging and the test harness
}
init();
