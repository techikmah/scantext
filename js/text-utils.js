// Pure text helpers — no DOM, no network — so they run the same in the browser and in
// the Node unit tests. Everything that decides "where does a line break", "how do we
// split text for a translator", or "which language is this" lives here.

// ---------- lines & words ----------

// A vertical-midpoint overlap test for "is this still the same line" — robust to the
// odd word running slightly high or low, unlike a strict y0 comparison. Shared by the
// selectable text layer and every text export path so they agree on line breaks.
export function isSameLine(prevWord, word) {
  const prevMidY = (prevWord.y0 + prevWord.y1) / 2;
  return word.y0 <= prevMidY && word.y1 >= prevMidY;
}

export function pageTextFromWords(words) {
  let out = "";
  let prev = null;
  for (const w of words || []) {
    if (!w.text || !w.text.trim()) continue;
    if (prev) out += isSameLine(prev, w) ? " " : "\n";
    out += w.text;
    prev = w;
  }
  return out;
}

// ---------- search ----------

const PUNCT_EDGE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

export function foldForSearch(s) {
  const nfc = String(s ?? "").normalize("NFC");
  const lower = nfc.toLowerCase();
  if (lower.length === nfc.length) return lower;
  // A few characters (İ, ẞ…) change length when lowercased, which would shift every
  // highlight offset after them. Keep those as they are so offsets stay valid.
  return Array.from(nfc, (ch) => {
    const l = ch.toLowerCase();
    return l.length === ch.length ? l : ch;
  }).join("");
}

function core(s) {
  const stripped = foldForSearch(s).replace(PUNCT_EDGE, "");
  return stripped || foldForSearch(s);
}

// Finds a (possibly multi-word) query in an OCR/native word list. Returns spans of
// word indices, [{start, end}] with end inclusive. A single token matches anywhere
// inside a word; a phrase must line up across consecutive words — the first token
// may be the tail of its word and the last token the head of its word, so
// "smith, john" still finds "Mr. Smith, John A.".
export function findWordMatches(words, query) {
  const tokens = foldForSearch(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !words || !words.length) return [];

  const lower = words.map((w) => foldForSearch(w.text));
  const spans = [];

  if (tokens.length === 1) {
    const t = tokens[0];
    for (let i = 0; i < lower.length; i++) if (lower[i].includes(t)) spans.push({ start: i, end: i });
    return spans;
  }

  const k = tokens.length;
  const cores = words.map((w) => core(w.text));
  for (let i = 0; i + k <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) {
      const w = lower[i + j];
      const c = cores[i + j];
      const t = tokens[j];
      const tc = t.replace(PUNCT_EDGE, "") || t;
      if (j === 0) ok = w.endsWith(t) || c.endsWith(tc);
      else if (j === k - 1) ok = w.startsWith(t) || c.startsWith(tc);
      else ok = w === t || c === tc;
    }
    if (ok) {
      spans.push({ start: i, end: i + k - 1 });
      i += k - 1; // don't report overlapping spans of the same phrase
    }
  }
  return spans;
}

// Every start offset of `query` inside `text`, case-insensitive, with runs of
// whitespace in the query matching any run of whitespace in the text.
export function findTextOccurrences(text, query) {
  const q = foldForSearch(query).trim();
  if (!q) return [];
  const source = foldForSearch(text);
  const parts = q.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(parts.join("\\s+"), "gu");
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    out.push({ index: m.index, length: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// ---------- CSV ----------

export function csvEscape(value) {
  let str = String(value ?? "");
  // Spreadsheet apps run cells that start with = + - @ as formulas. Scanned or imported
  // text is untrusted, so defuse those — but leave plain numbers like -5 or +91 98765 alone.
  if (/^[=+\-@\t\r]/.test(str) && !/^[+-]?[\d][\d\s.,]*$/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// RFC 4180-style parser. Handles quoted fields, escaped quotes, embedded newlines,
// CRLF/LF, and a trailing newline without inventing an empty last row.
export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const n = text.length;

  for (; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 12).filter(Boolean);
  if (!sample.length) return ",";
  let best = ",";
  let bestScore = 0;
  for (const d of [",", "\t", ";", "|"]) {
    const counts = sample.map((l) => parseDelimited(l, d)[0]?.length ?? 0);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

// ---------- hashing / sizes ----------

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const encoder = new TextEncoder();
export function utf8Length(s) {
  return encoder.encode(s).length;
}

// ---------- chunking for translators ----------

function fits(s, maxChars, maxBytes) {
  return s.length <= maxChars && (!maxBytes || utf8Length(s) <= maxBytes);
}

// Splits one over-long line at sentence ends, then spaces, then (last resort) hard
// cuts on code-point boundaries so a surrogate pair is never torn in half.
function splitLongLine(line, maxChars, maxBytes) {
  if (fits(line, maxChars, maxBytes)) return [line];
  const out = [];
  let rest = line;
  while (rest.length) {
    if (fits(rest, maxChars, maxBytes)) {
      out.push(rest);
      break;
    }
    let cut = -1;
    const window = Array.from(rest);
    // largest prefix (in code points) that fits
    let lo = 1;
    let hi = Math.min(window.length, maxChars);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(window.slice(0, mid).join(""), maxChars, maxBytes)) lo = mid;
      else hi = mid - 1;
    }
    const prefix = window.slice(0, lo).join("");
    const sentence = Math.max(
      prefix.lastIndexOf(". "),
      prefix.lastIndexOf("? "),
      prefix.lastIndexOf("! "),
      prefix.lastIndexOf("। "),
      prefix.lastIndexOf("。")
    );
    const space = prefix.lastIndexOf(" ");
    if (sentence > prefix.length * 0.4) cut = sentence + 1;
    else if (space > prefix.length * 0.4) cut = space;
    else cut = prefix.length;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return out.filter((s) => s.length);
}

// Groups lines into chunks no bigger than the engine allows, never splitting a line
// unless that single line is itself too long. Blank lines are dropped (they carry no
// text to translate) — the caller joins results with newlines.
export function chunkText(text, { maxChars = 1800, maxBytes = 0 } = {}) {
  const chunks = [];
  let current = "";
  const lines = String(text ?? "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    for (const piece of splitLongLine(line, maxChars, maxBytes)) {
      const candidate = current ? `${current}\n${piece}` : piece;
      if (current && !fits(candidate, maxChars, maxBytes)) {
        chunks.push(current);
        current = piece;
      } else current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- language detection ----------

// [regex of the script's letters, candidate languages — most likely first]
const SCRIPTS = [
  ["devanagari", /[ऀ-ॿ]/g, ["hi", "mr", "ne"]],
  ["bengali", /[ঀ-৿]/g, ["bn", "as"]],
  ["gurmukhi", /[਀-੿]/g, ["pa"]],
  ["gujarati", /[઀-૿]/g, ["gu"]],
  ["oriya", /[଀-୿]/g, ["or"]],
  ["tamil", /[஀-௿]/g, ["ta"]],
  ["telugu", /[ఀ-౿]/g, ["te"]],
  ["kannada", /[ಀ-೿]/g, ["kn"]],
  ["malayalam", /[ഀ-ൿ]/g, ["ml"]],
  ["sinhala", /[඀-෿]/g, ["si"]],
  ["arabic", /[؀-ۿݐ-ݿ]/g, ["ar", "ur", "fa", "ps"]],
  ["hebrew", /[֐-׿]/g, ["he", "yi"]],
  ["thai", /[฀-๿]/g, ["th"]],
  ["lao", /[຀-໿]/g, ["lo"]],
  ["myanmar", /[က-႟]/g, ["my"]],
  ["khmer", /[ក-៿]/g, ["km"]],
  ["georgian", /[Ⴀ-ჿ]/g, ["ka"]],
  ["armenian", /[԰-֏]/g, ["hy"]],
  ["ethiopic", /[ሀ-፿]/g, ["am"]],
  ["greek", /[Ͱ-Ͽ]/g, ["el"]],
  ["hangul", /[가-힯ᄀ-ᇿ]/g, ["ko"]],
  ["kana", /[぀-ヿ]/g, ["ja"]],
  ["han", /[一-鿿]/g, ["zh", "ja"]],
  ["cyrillic", /[Ѐ-ӿ]/g, ["ru", "uk", "bg", "sr"]],
  ["latin", /[A-Za-zÀ-ɏ]/g, ["en"]],
];

// Function words are the cheapest reliable signal for Latin-script languages.
const STOPWORDS = {
  en: "the of and to in is that it was for on are with as this be at by from or an have not but they which you",
  es: "de la que el en y a los se del las por un para con no una su al es lo como más pero sus le ya o",
  fr: "de la le et les des en un du une que est pour qui dans par plus pas au sur ne se ce il sont avec",
  de: "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden",
  pt: "de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele",
  it: "di e il la che in un per è con non una del le si da come più ma al lo sono dei gli alla",
  nl: "de van het een en in is dat op te zijn met voor niet aan er ook als bij maar om dan nog door",
  id: "yang dan di dengan untuk dari dalam tidak ini itu pada adalah ke juga akan atau oleh sebagai ada",
  sv: "och i att det som en på är av för med den till inte har de ett om men var sig från så",
  pl: "i w nie na z do to się że jest jak po co ale od tak za przez czy tylko już jego",
  tr: "ve bir bu için ile da de olarak çok daha gibi en ama ne var olan ben sen kadar sonra",
};
const STOPSETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

// Returns {code, confidence:"high"|"low", script}. `hints` are ISO-639-1 codes the
// user's OCR languages imply — used to break ties between languages that share a
// script (Hindi vs Marathi, Arabic vs Urdu) and as the fallback when there's no signal.
export function detectLanguage(text, hints = []) {
  const sample = String(text ?? "").slice(0, 6000);
  const counts = SCRIPTS.map(([name, re, cands]) => ({ name, cands, n: (sample.match(re) || []).length }));
  const total = counts.reduce((s, c) => s + c.n, 0);
  if (total < 3) return { code: hints[0] || "en", confidence: "low", script: null };

  // Kana beats Han: Japanese text is full of Han characters but always has kana.
  const kana = counts.find((c) => c.name === "kana").n;
  const han = counts.find((c) => c.name === "han").n;
  if (kana > 0 && kana >= han * 0.1) return { code: "ja", confidence: "high", script: "kana" };

  const top = counts.slice().sort((a, b) => b.n - a.n)[0];

  if (top.name === "latin") {
    const words = sample.toLowerCase().match(/[a-zÀ-ɏ']+/g) || [];
    let best = null;
    let bestScore = 0;
    let second = 0;
    for (const [code, set] of Object.entries(STOPSETS)) {
      const hits = words.reduce((s, w) => s + (set.has(w) ? 1 : 0), 0);
      if (hits > bestScore) {
        second = bestScore;
        bestScore = hits;
        best = code;
      } else if (hits > second) second = hits;
    }
    const enough = bestScore >= 3 && bestScore >= second * 1.3;
    if (enough) return { code: best, confidence: "high", script: "latin" };
    const latinHint = hints.find((h) => STOPSETS[h]);
    return { code: latinHint || best || "en", confidence: "low", script: "latin" };
  }

  const hinted = top.cands.find((c) => hints.includes(c));
  return { code: hinted || top.cands[0], confidence: "high", script: top.name };
}

// Some PDFs (typically Indic-script ones produced by office software) store shaped
// glyph fragments, so a text layer comes out as "नमस् ते दु निन या" — letters present,
// words destroyed. The tell is words that begin with a combining mark or end on a
// virama, which a real word never does. Returns true when enough of them show up that
// searching the native text would be unreliable.
const VIRAMAS = /[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D]$/u;
const LEADING_MARK = /^\p{M}/u;

export function hasBrokenShaping(words) {
  const list = (words || []).map((w) => w.text).filter((t) => t && /[\u0900-\u0DFF]/.test(t));
  if (list.length < 3) return false;
  const bad = list.filter((t) => VIRAMAS.test(t) || LEADING_MARK.test(t)).length;
  return bad / list.length > 0.04;
}
