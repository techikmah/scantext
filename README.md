# ScanText — web app

Open a scanned PDF, a phone photo or an office file, and search it, copy from it,
translate it and save the result as Word, CSV, JSON or plain text. Reading happens in
the browser. There is no account, no upload and no server of ours.

It is a static site: `index.html` plus plain ES modules. No build step.

## What it opens

| Kind | Formats | How it's read |
|---|---|---|
| PDF | `.pdf` | Text already inside the PDF is used as-is. Pages that are only pictures go to OCR. |
| Images | `.png .jpg .jpeg .webp .gif .bmp .avif` | OCR, with an optional clean-up pass for phone photos. Paste (`Ctrl+V`) and camera capture work too. |
| TIFF | `.tif .tiff` (multi-page too) | Decoded in the browser, then OCR. |
| Word | `.docx` | Headings, paragraphs, lists and tables. |
| PowerPoint | `.pptx` | One page per slide, with tables and speaker notes. |
| Excel | `.xlsx` | One page per sheet (long sheets split every 400 rows). Dates are shown as dates, not serial numbers. |
| OpenDocument | `.odt .ods .odp` | Same as their Office twins. |
| Plain data | `.csv .tsv .txt .md .log .json .xml .html .htm .rtf` | CSV delimiter is detected; old Windows-1252 files are decoded correctly. |

Several files can be open at once. Search runs across all of them, and Enter moves on
into the next document that has a match.

Not supported, with a message that says what to do instead: old `.doc/.xls/.ppt`
(save as the modern format or PDF) and `.heic` (export as JPG or PNG).

## Translation

Open the Translate panel, pick the language to translate **into**, and press
Translate document. You can also translate one page, or select text and press
Translate in the little bar that appears. Results are kept per language, listed page
by page, and can be exported (translated `.txt`, translated `.docx`, and a translation
column in the CSV and JSON exports).

The source language is detected automatically. Non-Latin scripts are identified from
the script itself (Devanagari, Tamil, Arabic, CJK and so on); Latin-script text is
identified from common words, or by Chrome's language detector when it has one. If the
detection is wrong, set "From" yourself.

There are three engines. **Automatic** (the default) tries them in this order:

1. **Chrome, on this device** — Chrome's built-in Translator API (desktop Chrome 138+
   or Edge). Your text never leaves the computer. The first use of a language pair
   downloads a language pack.
2. **Your LibreTranslate server** — if you have entered one in Settings. Works with
   any server that implements `POST /translate`. The server must allow requests from
   the site (CORS).
3. **MyMemory** — a free public service, available everywhere.

**Privacy:** options 2 and 3 send the text to a server. ScanText says so in the panel
and asks for confirmation the first time each one is used. Nothing else is ever sent,
and files and images always stay in the browser.

Limits worth knowing:

- MyMemory allows about 5,000 characters a day per visitor (50,000 if you enter an
  email in Settings) and 500 bytes per request. ScanText splits text to fit, and says
  plainly when the daily limit is reached. Translated chunks are cached in the browser,
  so retrying never pays twice for the same text.
- Chrome's translator supports a subset of languages; if a pair isn't available the
  panel falls through to the next engine, or tells you which settings to change.
- Machine translation of OCR text is only as good as the OCR. Check names and numbers.

## Privacy, in one place

- Files are opened and read locally.
- OCR language data is downloaded from a public CDN the first time a language is used
  (see "Fully offline" below).
- Results (words and positions, never page images) and translated chunks are cached in
  this browser's IndexedDB. "Clear saved translations" is in Settings.
- Settings, including an optional LibreTranslate key, are stored in this browser
  unencrypted. Use a key you can revoke.

## Run it locally

ES modules don't load over `file://`, so use any static server:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

## Deploy it

Any static host works: GitHub Pages (push the folder, then Settings → Pages),
Netlify, Cloudflare Pages, Vercel. It works from a sub-path such as
`username.github.io/scantext/` because every asset is resolved relative to the script
that loads it.

Package size is about 16 MB, mostly the Tesseract engine (three WebAssembly builds;
the browser loads the one it can run) and pdf.js. Browsers cache it after the first
visit.

### Fully offline OCR

By default Tesseract fetches `<lang>.traineddata.gz` from a CDN on first use. To host
the language files yourself, put the gzipped files in a folder (for example
`tessdata/eng.traineddata.gz`) and add this line to `index.html` before the module
script:

```html
<script>window.SCANTEXT_LANG_PATH = "./tessdata";</script>
```

## Known limits

- Very large scans use a lot of memory: each page is rendered to a canvas. Files over
  about 120 pages show a warning; split them if the tab slows down.
- Images embedded *inside* a Word, PowerPoint or ODF file are not OCR'd, and Word
  headers, footers and footnotes are not read. Export the document to PDF to read
  those.
- Some PDFs made by office software split Indian-script words into glyph fragments.
  ScanText detects this and, if you have added the language in Settings, reads those
  pages with OCR instead.
- Changing the reading language in Settings applies to files opened afterwards.
- CSV exports prefix text that starts with = + - or @ with an apostrophe, so spreadsheet apps never run it as a formula.
- Online translation needs a network connection; everything else works without one
  once the OCR language data has been fetched.

## Tests

```bash
npm install                 # installs linkedom, used only by the parser tests
npm test                    # 31 unit tests: parsers, search, chunking, detection, engines, exports, review regressions

python3 -m http.server 8765 &
python3 tests/e2e.py http://localhost:8765
```

The end-to-end test drives headless Chromium (Playwright for Python) with real files
from `tests/fixtures`: a scanned PDF, a multi-page TIFF, a photo, DOCX, PPTX, XLSX,
ODF, CSV and HTML. It serves OCR language data from a local Tesseract install and fakes
the translation services, so it runs offline. Edit `TESSDATA` at the top of the script
if your Tesseract data lives elsewhere.

## Layout

```
index.html          the page
app.css             design tokens (light and dark) and layout
js/app.js           documents, viewer, search, selection, translate panel, export
js/loaders.js       file type detection and the Office/OpenDocument/CSV/HTML/RTF parsers
js/translate.js     engines, language detection, chunking
js/exporters.js     CSV, JSON, TXT and DOCX builders
js/ocr.js           Tesseract worker handling and photo clean-up
js/text-utils.js    pure helpers (lines, phrase search, CSV, chunking, detection)
js/cache.js         IndexedDB cache and settings
js/languages.js     the 125 OCR languages
lib/                pdf.js, Tesseract.js and cores, docx, fflate, UTIF (all vendored)
fonts/              Bricolage Grotesque and Source Serif 4 (SIL Open Font License)
tests/              unit tests, end-to-end test, fixtures
```

## Third-party code

pdf.js (Apache 2.0), Tesseract.js and Tesseract (Apache 2.0), docx (MIT), fflate (MIT),
UTIF.js via utif2 (MIT), Bricolage Grotesque and Source Serif 4 (SIL OFL 1.1).
