// OCR via Tesseract.js (WASM, runs in a worker on this device). One shared worker for
// the whole app; switching languages reinitialises it rather than reloading the engine.

import Tesseract from "../lib/tesseract/tesseract.esm.min.js";

const { createWorker, OEM, PSM } = Tesseract;
const LIB_BASE = new URL("../lib/", import.meta.url);

let worker = null;
let workerReady = null;
let loadedLangs = null;
let langPath; // undefined = Tesseract's default CDN

export const OCR_TIMEOUT_MS = 60000;

/** Point language data at your own host (or a bundled folder) for fully offline use. */
export function setLangPath(path) {
  langPath = path || undefined;
}

const sameLangs = (a, b) => !!a && a.length === b.length && b.every((c) => a.includes(c));

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getWorker(langs, onStatus) {
  if (!workerReady) {
    workerReady = (async () => {
      onStatus && onStatus("Loading the text reader (first time only)…");
      const opts = {
        workerPath: new URL("tesseract/worker.min.js", LIB_BASE).href,
        corePath: new URL("tesseract-core/", LIB_BASE).href,
        workerBlobURL: false,
      };
      if (langPath) opts.langPath = langPath;
      const w = await createWorker(langs, OEM.LSTM_ONLY, opts);
      await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      worker = w;
      loadedLangs = langs.slice();
      return w;
    })().catch((err) => {
      // Never leave a rejected promise cached — that would break every later page too.
      workerReady = null;
      worker = null;
      loadedLangs = null;
      throw err;
    });
  }
  const w = await workerReady;
  if (!sameLangs(loadedLangs, langs)) {
    onStatus && onStatus("Switching reading language…");
    await w.reinitialize(langs, OEM.LSTM_ONLY);
    loadedLangs = langs.slice();
  }
  return w;
}

// Stretches contrast and flattens colour on a *copy* of the canvas. Phone photos of
// paper are the main beneficiary: grey-on-grey shadows become readable. The copy is
// only used for recognition — the page the user sees is never altered.
export function enhanceCanvas(src) {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    hist[g | 0]++;
  }
  const total = d.length / 4;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * 0.02) {
      hi = v;
      break;
    }
  }
  const range = Math.max(40, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    const v = Math.max(0, Math.min(255, ((g - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Loads the engine and language data ahead of recognition, so a slow first download
 *  is reported as such instead of eating into a page's recognition timeout. */
export async function prepareOcr(langs, onStatus) {
  await getWorker(langs, onStatus);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{langs:string[], enhance?:boolean, onStatus?:(s:string)=>void}} opts
 * @returns {Promise<{text:string,x0:number,y0:number,x1:number,y1:number}[]>}
 */
/** Throws away the shared worker (a hung job can't be cancelled), so the next page starts fresh. */
export async function resetWorker() {
  const w = worker;
  worker = null;
  workerReady = null;
  loadedLangs = null;
  try {
    if (w) await w.terminate();
  } catch {
    /* already gone */
  }
}

export async function ocrCanvas(canvas, { langs, enhance = false, onStatus } = {}) {
  const w = await getWorker(langs, onStatus);
  const target = enhance ? enhanceCanvas(canvas) : canvas;
  const { data } = await w.recognize(target, {}, { blocks: true });
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const wd of line.words || []) {
          if (!wd.text || !wd.text.trim()) continue;
          words.push({ text: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
        }
      }
    }
  }
  return words;
}
