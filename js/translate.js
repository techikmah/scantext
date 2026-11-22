// Translation layer: three interchangeable engines behind one small interface.
//
//   chrome     — Chrome/Edge's built-in Translator API. Runs on this device; the text
//                never leaves the computer. Desktop Chrome 138+/Edge only.
//   libre      — any LibreTranslate-compatible server the user points us at (their own,
//                or a hosted one with an API key).
//   mymemory   — the free MyMemory web API. Works everywhere but sends text to
//                api.mymemory.translated.net, so it needs the user's consent first.
//
// Nothing in here touches the DOM, and `fetch` / `Translator` / `LanguageDetector` are
// looked up at call time, so the Node tests can swap in fakes.

import { chunkText, detectLanguage, fnv1a } from "./text-utils.js";

// ---------- languages ----------

// code is BCP-47 as the UI sees it. Per-engine spelling differences are handled in
// each engine's `code()` below (Chinese is the main offender).
export const TRANSLATE_LANGS = [
  ["en", "English"], ["hi", "Hindi", "हिन्दी"], ["bn", "Bengali", "বাংলা"], ["ta", "Tamil", "தமிழ்"],
  ["te", "Telugu", "తెలుగు"], ["mr", "Marathi", "मराठी"], ["gu", "Gujarati", "ગુજરાતી"],
  ["kn", "Kannada", "ಕನ್ನಡ"], ["ml", "Malayalam", "മലയാളം"], ["pa", "Punjabi", "ਪੰਜਾਬੀ"],
  ["ur", "Urdu", "اردو"], ["ne", "Nepali", "नेपाली"], ["si", "Sinhala", "සිංහල"], ["or", "Odia", "ଓଡ଼ିଆ"],
  ["as", "Assamese", "অসমীয়া"], ["ar", "Arabic", "العربية"], ["fa", "Persian", "فارسی"],
  ["he", "Hebrew", "עברית"], ["tr", "Turkish"], ["ru", "Russian", "Русский"], ["uk", "Ukrainian", "Українська"],
  ["bg", "Bulgarian", "Български"], ["sr", "Serbian", "Српски"], ["hr", "Croatian"], ["sl", "Slovenian"],
  ["pl", "Polish"], ["cs", "Czech"], ["sk", "Slovak"], ["hu", "Hungarian"], ["ro", "Romanian"],
  ["el", "Greek", "Ελληνικά"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["pt", "Portuguese"],
  ["it", "Italian"], ["nl", "Dutch"], ["sv", "Swedish"], ["no", "Norwegian"], ["da", "Danish"],
  ["fi", "Finnish"], ["is", "Icelandic"], ["et", "Estonian"], ["lv", "Latvian"], ["lt", "Lithuanian"],
  ["id", "Indonesian"], ["ms", "Malay"], ["th", "Thai", "ไทย"], ["vi", "Vietnamese"], ["fil", "Filipino"],
  ["ja", "Japanese", "日本語"], ["ko", "Korean", "한국어"], ["zh", "Chinese (Simplified)", "简体中文"],
  ["zh-TW", "Chinese (Traditional)", "繁體中文"], ["my", "Burmese", "မြန်မာ"], ["km", "Khmer", "ខ្មែរ"],
  ["ka", "Georgian", "ქართული"], ["hy", "Armenian", "Հայերեն"], ["sw", "Swahili"], ["af", "Afrikaans"],
  ["am", "Amharic", "አማርኛ"], ["ca", "Catalan"], ["eu", "Basque"], ["gl", "Galician"], ["cy", "Welsh"],
  ["ga", "Irish"], ["sq", "Albanian"], ["mk", "Macedonian", "Македонски"], ["be", "Belarusian"],
  ["kk", "Kazakh"], ["uz", "Uzbek"], ["az", "Azerbaijani"], ["mn", "Mongolian"], ["lo", "Lao"],
].map(([code, name, native]) => ({ code, name, native: native || name }));

export const RTL_LANGS = new Set(["ar", "fa", "he", "ur", "yi", "ps"]);

export function langName(code) {
  return TRANSLATE_LANGS.find((l) => l.code === code)?.name || code;
}

// Tesseract's 3-letter codes → the ISO-639-1 codes translators use. Only the ones that
// have a translation counterpart; the rest simply give no hint.
export const OCR_TO_ISO = {
  eng: "en", hin: "hi", ben: "bn", tam: "ta", tel: "te", mar: "mr", guj: "gu", kan: "kn", mal: "ml",
  pan: "pa", urd: "ur", nep: "ne", sin: "si", ori: "or", asm: "as", ara: "ar", fas: "fa", heb: "he",
  tur: "tr", rus: "ru", ukr: "uk", bul: "bg", srp: "sr", hrv: "hr", slv: "sl", pol: "pl", ces: "cs",
  slk: "sk", hun: "hu", ron: "ro", ell: "el", deu: "de", fra: "fr", spa: "es", por: "pt", ita: "it",
  nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", isl: "is", est: "et", lav: "lv", lit: "lt",
  ind: "id", msa: "ms", tha: "th", vie: "vi", fil: "fil", jpn: "ja", jpn_vert: "ja", kor: "ko",
  chi_sim: "zh", chi_tra: "zh-TW", mya: "my", khm: "km", kat: "ka", hye: "hy", swa: "sw", afr: "af",
  amh: "am", cat: "ca", eus: "eu", glg: "gl", cym: "cy", gle: "ga", sqi: "sq", mkd: "mk", bel: "be",
  kaz: "kk", uzb: "uz", aze: "az", lao: "lo",
};

export function ocrHints(ocrCodes) {
  return (ocrCodes || []).map((c) => OCR_TO_ISO[c]).filter(Boolean);
}

// ---------- errors ----------

export class TranslateError extends Error {
  /** @param {"quota"|"network"|"unsupported"|"config"|"cancelled"|"server"} kind */
  constructor(message, kind) {
    super(message);
    this.name = "TranslateError";
    this.kind = kind;
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new TranslateError("Translation stopped.", "cancelled");
}

// ---------- engine: Chrome on-device ----------

const chromeTranslators = new Map();

// Some browsers expose Translator/LanguageDetector but never answer availability()
// (headless builds, or a language-pack component that can't be fetched). Without a
// deadline the whole panel would hang, so a silent browser counts as "not available".
function probe(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function chromeCode(code) {
  if (code === "zh") return "zh";
  if (code === "zh-TW") return "zh-Hant";
  return code;
}

export const chromeEngine = {
  id: "chrome",
  label: "Chrome, on this device",
  online: false,
  host: null,
  maxChars: 2000,
  maxBytes: 0,
  probeTimeoutMs: 3000,

  installed() {
    return typeof globalThis.Translator !== "undefined" && typeof globalThis.Translator.create === "function";
  },

  _slow: new Map(), // pairs whose probe timed out → don't make the user wait again
  _slowFor: null,

  async supports(src, tgt) {
    if (!this.installed()) return false;
    if (this._slowFor !== globalThis.Translator) {
      this._slow.clear();
      this._slowFor = globalThis.Translator;
    }
    const key = `${src}>${tgt}`;
    if (this._slow.has(key) && Date.now() - this._slow.get(key) < 60000) return false;
    try {
      const a = await probe(
        globalThis.Translator.availability({
          sourceLanguage: chromeCode(src),
          targetLanguage: chromeCode(tgt),
        }),
        this.probeTimeoutMs
      );
      if (a === "timeout") this._slow.set(key, Date.now());
      return a !== "unavailable" && a !== "timeout";
    } catch {
      return false;
    }
  },

  // Creating a translator needs a recent click (user activation) and may download a
  // language pack on first use, so this is called straight from the Translate button.
  async prepare(src, tgt, cfg = {}) {
    const key = `${src}>${tgt}`;
    if (chromeTranslators.has(key)) return chromeTranslators.get(key);
    const promise = globalThis.Translator.create({
      sourceLanguage: chromeCode(src),
      targetLanguage: chromeCode(tgt),
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => cfg.onDownload && cfg.onDownload(e.loaded));
      },
    }).catch((err) => {
      chromeTranslators.delete(key);
      if (err && err.name === "NotAllowedError") {
        throw new TranslateError("Chrome needs a click to start the language download. Press Translate again.", "config");
      }
      throw new TranslateError(`Chrome couldn't set up this language pair: ${err && err.message ? err.message : err}`, "unsupported");
    });
    chromeTranslators.set(key, promise);
    return promise;
  },

  async translate(text, src, tgt, cfg, signal) {
    throwIfAborted(signal);
    const t = await this.prepare(src, tgt, cfg);
    throwIfAborted(signal);
    try {
      return await t.translate(text);
    } catch (err) {
      throw new TranslateError(`Chrome's translator failed: ${err && err.message ? err.message : err}`, "server");
    }
  },
};

// ---------- engine: LibreTranslate-compatible ----------

function libreCode(code) {
  if (code === "zh-TW") return "zt";
  return code;
}

export const libreEngine = {
  id: "libre",
  label: "LibreTranslate server",
  online: true,
  maxChars: 2000,
  maxBytes: 0,

  get host() {
    return null; // filled in from config at call time — see engineHost()
  },

  configured(cfg) {
    return !!(cfg && cfg.libreUrl && /^https?:\/\//i.test(cfg.libreUrl));
  },

  async supports(_src, _tgt, cfg) {
    return this.configured(cfg);
  },

  async translate(text, src, tgt, cfg, signal) {
    throwIfAborted(signal);
    if (!this.configured(cfg)) {
      throw new TranslateError("Add your LibreTranslate server address in Settings first.", "config");
    }
    const url = `${cfg.libreUrl.replace(/\/+$/, "")}/translate`;
    const body = { q: text, source: libreCode(src), target: libreCode(tgt), format: "text" };
    if (cfg.libreKey) body.api_key = cfg.libreKey;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal && signal.aborted) throw new TranslateError("Translation stopped.", "cancelled");
      throw new TranslateError(
        "Couldn't reach the LibreTranslate server. Check the address, and that the server allows requests from this site (CORS).",
        "network"
      );
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (res.status === 429) throw new TranslateError("The LibreTranslate server is rate-limiting requests. Wait a moment and retry.", "quota");
    if (res.status === 400 || res.status === 403) {
      throw new TranslateError((json && json.error) || "The LibreTranslate server rejected the request (check the API key).", "config");
    }
    if (!res.ok || !json || typeof json.translatedText !== "string") {
      throw new TranslateError((json && json.error) || `LibreTranslate returned an error (${res.status}).`, "server");
    }
    return json.translatedText;
  },
};

// ---------- engine: MyMemory ----------

function myMemoryCode(code) {
  if (code === "zh") return "zh-CN";
  return code;
}

const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&nbsp;": " " };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(quot|amp|lt|gt|apos|nbsp);/g, (m) => ENTITIES[m]);
}

export const myMemoryEngine = {
  id: "mymemory",
  label: "MyMemory (online)",
  online: true,
  host: "api.mymemory.translated.net",
  // The API caps each request at 500 *bytes* of query text, which is only ~160
  // characters of Devanagari or CJK — so size chunks by bytes, not characters.
  maxChars: 450,
  maxBytes: 480,

  async supports() {
    return true;
  },

  async translate(text, src, tgt, cfg, signal) {
    throwIfAborted(signal);
    const params = new URLSearchParams({ q: text, langpair: `${myMemoryCode(src)}|${myMemoryCode(tgt)}` });
    if (cfg && cfg.myMemoryEmail) params.set("de", cfg.myMemoryEmail);

    let res;
    try {
      res = await fetch(`https://api.mymemory.translated.net/get?${params}`, { signal });
    } catch (err) {
      if (signal && signal.aborted) throw new TranslateError("Translation stopped.", "cancelled");
      throw new TranslateError("Couldn't reach the MyMemory translation service. Check your connection and try again.", "network");
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    const detail = json && (json.responseDetails || (json.responseData && json.responseData.translatedText)) || "";
    const status = Number(json && json.responseStatus);

    if (res.status === 429 || status === 429 || /MYMEMORY WARNING|USED ALL AVAILABLE FREE/i.test(String(detail))) {
      throw new TranslateError(
        "MyMemory's free daily limit has been reached (5,000 characters without an email, 50,000 with one). " +
          "Add an email in Settings to raise it, try again tomorrow, or use Chrome's on-device translator or your own LibreTranslate server.",
        "quota"
      );
    }
    if (!res.ok || !json || !json.responseData || typeof json.responseData.translatedText !== "string") {
      throw new TranslateError(`MyMemory returned an error${detail ? `: ${detail}` : ""}.`, "server");
    }
    if (status && status !== 200) {
      throw new TranslateError(`MyMemory couldn't translate this${detail ? `: ${detail}` : ""}.`, "server");
    }
    return decodeEntities(json.responseData.translatedText);
  },
};

export const ENGINES = { chrome: chromeEngine, libre: libreEngine, mymemory: myMemoryEngine };

export function engineHost(engine, cfg) {
  if (engine.id === "libre") {
    try {
      return new URL(cfg.libreUrl).host;
    } catch {
      return "your server";
    }
  }
  return engine.host;
}

// Human description for the UI — says plainly where the text goes.
export function describeEngine(engine, cfg) {
  if (!engine) return "";
  if (!engine.online) return `${engine.label} — your text never leaves this computer.`;
  return `${engine.label} — text is sent to ${engineHost(engine, cfg)}.`;
}

// pref: "auto" | "chrome" | "libre" | "mymemory". Auto prefers whatever keeps text on
// the device, then a server the user configured themselves, then the public service.
export async function pickEngine(pref, src, tgt, cfg) {
  const order = pref && pref !== "auto" ? [pref] : ["chrome", "libre", "mymemory"];
  for (const id of order) {
    const engine = ENGINES[id];
    if (!engine) continue;
    if (id === "libre" && !libreEngine.configured(cfg)) {
      if (pref === "libre") throw new TranslateError("Add your LibreTranslate server address in Settings first.", "config");
      continue;
    }
    if (await engine.supports(src, tgt, cfg)) return engine;
    if (pref && pref !== "auto") {
      throw new TranslateError(
        id === "chrome"
          ? "Chrome's built-in translator isn't available here for that language pair. It needs desktop Chrome 138+ or Edge — pick another engine in Settings."
          : "That engine doesn't support this language pair.",
        "unsupported"
      );
    }
  }
  throw new TranslateError("No translation engine is available for this language pair.", "unsupported");
}

// ---------- source-language detection ----------

// Non-Latin scripts identify the language reliably on their own. Only Latin-script
// text — where Spanish and Portuguese or Indonesian and Malay are easily confused —
// is worth handing to Chrome's detector when it exists.
export async function detectSource(text, hints = []) {
  const heuristic = detectLanguage(text, hints);
  if (heuristic.script !== "latin" || heuristic.confidence === "high") return heuristic;
  try {
    if (typeof globalThis.LanguageDetector !== "undefined") {
      const detector = await probe(globalThis.LanguageDetector.create(), chromeEngine.probeTimeoutMs);
      if (detector === "timeout") return heuristic;
      const results = await probe(detector.detect(String(text).slice(0, 1500)), chromeEngine.probeTimeoutMs);
      detector.destroy && detector.destroy();
      if (results === "timeout") return heuristic;
      const top = results && results[0];
      if (top && top.detectedLanguage && top.detectedLanguage !== "und" && top.confidence >= 0.6) {
        const code = top.detectedLanguage.split("-")[0];
        return { code: code === "zh" ? "zh" : code, confidence: "high", script: "latin" };
      }
    }
  } catch {
    /* fall through to the heuristic's answer */
  }
  return heuristic;
}

// ---------- translating text ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translates `text` in engine-sized chunks.
 * @param {string} text
 * @param {{engine, src:string, tgt:string, cfg?:object, signal?:AbortSignal,
 *          cache?:{get(k):Promise<string|null>|string|null, set(k,v):any},
 *          onProgress?:(done:number,total:number)=>void}} opts
 */
export async function translateText(text, opts) {
  const { engine, src, tgt, cfg = {}, signal, cache, onProgress } = opts;
  if (src === tgt) return String(text);

  const chunks = chunkText(text, { maxChars: engine.maxChars, maxBytes: engine.maxBytes });
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const chunk = chunks[i];
    const key = `${engine.id}|${src}|${tgt}|${fnv1a(chunk)}${chunk.length}`;

    let result = cache ? await cache.get(key) : null;
    if (result == null) {
      let attempt = 0;
      for (;;) {
        try {
          result = await engine.translate(chunk, src, tgt, cfg, signal);
          break;
        } catch (err) {
          const retryable = err instanceof TranslateError && err.kind === "network";
          if (!retryable || attempt >= 2) throw err;
          attempt += 1;
          await sleep(500 * attempt);
        }
      }
      if (cache) await cache.set(key, result);
    }
    out.push(result);
    if (onProgress) onProgress(i + 1, chunks.length);
  }
  return out.join("\n");
}
