"""End-to-end test: drives the real app in headless Chromium with real files.

Run (a static server must be serving the app folder):
    python3 -m http.server 8765 &     # from the web app folder
    python3 tests/e2e.py [http://localhost:8765] [screenshot-dir]

Network is stubbed: OCR language data is served from the local Tesseract install and
the translation services are faked, so the test is hermetic.
"""
import asyncio, gzip, json, os, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
FX = Path(__file__).parent / "fixtures"
TESSDATA = Path("/usr/share/tesseract-ocr/5/tessdata")

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

async def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(SHOTS / f"{name}.png"))

FAKE_TRANSLATOR = """
window.Translator = {
  availability: async () => 'downloadable',
  create: async ({sourceLanguage, targetLanguage, monitor}) => {
    monitor && monitor({addEventListener:(n,cb)=>{cb({loaded:0.5});cb({loaded:1});}});
    return { translate: async (t) => '[' + sourceLanguage + '>' + targetLanguage + '] ' + t };
  }
};
"""

async def new_page(browser, *, chrome_translator=False, mm_mode="ok", **ctx_kw):
    ctx = await browser.new_context(accept_downloads=True, viewport={"width": 1360, "height": 860}, **ctx_kw)
    if chrome_translator:
        await ctx.add_init_script(FAKE_TRANSLATOR)
    page = await ctx.new_page()
    logs = []
    # Tesseract prints "Estimating resolution" at error level for images without DPI metadata — noise.
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type == "error" and not any(s in m.text for s in ("Estimating resolution", "Detected ", "broken.docx")) else None)
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    page.mm_requests = []

    async def tess(route):
        lang = route.request.url.rsplit("/", 1)[-1].split(".")[0]
        f = TESSDATA / f"{lang}.traineddata"
        if not f.exists():
            return await route.fulfill(status=404, body="no")
        await route.fulfill(status=200, body=gzip.compress(f.read_bytes()), headers={"content-type": "application/gzip"})
    await page.route("**/*.traineddata.gz", tess)

    async def mm(route):
        u = urllib.parse.urlparse(route.request.url)
        q = urllib.parse.parse_qs(u.query)
        page.mm_requests.append(q)
        if mm_mode == "quota":
            body = {"responseData": {"translatedText": "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY."}, "responseStatus": 200}
        else:
            pair = q["langpair"][0]
            body = {"responseData": {"translatedText": f"[{pair}] " + q["q"][0].replace("'", "&#39;")}, "responseStatus": 200}
        await route.fulfill(status=200, body=json.dumps(body), headers={"content-type": "application/json", "access-control-allow-origin": "*"})
    await page.route("https://api.mymemory.translated.net/**", mm)
    page.logs = logs
    return ctx, page

async def wait_done(page, n, timeout=150000):
    await page.wait_for_function(
        f"() => {{ const d = window.__scantext.state.docs; return d.length === {n} && d.every(x => x.status === 'done' || x.status === 'error'); }}",
        timeout=timeout)

async def docs(page):
    return await page.evaluate("""() => window.__scantext.state.docs.map(d => ({
        name: d.name, status: d.status, error: d.error, pages: d.pages.length, hits: d.hitTotal,
        sources: d.pages.map(p => p.source),
        text: d.pages.map(p => p.kind === 'canvas' ? p.words.map(w => w.text).join(' ') : p.text).join('\\n')}))""")

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()

        # ---------------------------------------------------------------- intake
        print("Open many file types at once")
        ctx, page = await new_page(browser)
        await page.goto(BASE + "/index.html")
        await page.wait_for_function("() => window.__scantext")
        files = ["note.png", "scan.pdf", "multi.tif", "report.docx", "book.xlsx", "deck.pptx", "semi.csv", "report.odt", "page.html"]
        await page.set_input_files("#fileInput", [str(FX / f) for f in files])
        await wait_done(page, len(files))
        info = {d["name"]: d for d in await docs(page)}
        await shot(page, "01-opened")
        check(all(d["status"] == "done" for d in info.values()), "every file opened without error: " + str({k: v["error"] for k, v in info.items() if v["error"]}))
        check(info["note.png"]["pages"] == 1 and "Meena" in info["note.png"]["text"], "photo: 1 page, OCR found 'Meena'")
        check("committee" in info["note.png"]["text"].lower(), "photo: OCR read body text")
        check(info["scan.pdf"]["pages"] == 2 and info["scan.pdf"]["sources"] == ["ocr", "ocr"], "image-only PDF: 2 pages, both via OCR")
        check("Register" in info["scan.pdf"]["text"], "PDF page 2 text read")
        check(info["multi.tif"]["pages"] == 2 and "Register" in info["multi.tif"]["text"], "multi-page TIFF: 2 frames, second read")
        check(info["report.docx"]["pages"] >= 2 and "Revenue grew" in info["report.docx"]["text"], "docx opened with pagination")
        check("Gadget, large" in info["book.xlsx"]["text"] and "2026-03-14" in info["book.xlsx"]["text"], "xlsx: values and dates")
        check("Launch plan" in info["deck.pptx"]["text"], "pptx opened")
        check("line one\nline two" in info["semi.csv"]["text"], "csv: quoted newline preserved")
        check("नमस्ते" in info["report.odt"]["text"], "odt: Devanagari preserved")
        check("Heading One" in info["page.html"]["text"], "html opened")
        check(await page.locator(".doc-item").count() == len(files), "tray lists every document")

        # ---------------------------------------------------------------- search
        print("Search across documents")
        await page.fill("#searchInput", "meena")
        await page.wait_for_timeout(500)
        hits = {d["name"]: d["hits"] for d in await docs(page)}
        check(hits["note.png"] >= 1 and hits["scan.pdf"] >= 1 and hits["multi.tif"] >= 1, f"hit counts per doc: {({k:v for k,v in hits.items() if v})}")
        check(hits["report.docx"] == 0, "no false hits in unrelated doc")
        chips = await page.locator(".doc-hits:visible").count()
        check(chips == len(files), "every tray item shows a hit chip while searching")
        # step through matches until we cross into another document
        first_doc = await page.evaluate("() => window.__scantext.state.activeId")
        label = await page.inner_text("#matchLabel")
        check("of" in label, f"match label shows position ('{label}')")
        for _ in range(8):
            await page.keyboard.press("Enter")
        second_doc = await page.evaluate("() => window.__scantext.state.activeId")
        check(first_doc != second_doc, "Enter steps across into the next document with matches")
        await shot(page, "02-search")
        await page.fill("#searchInput", "revenue grew")
        await page.wait_for_timeout(400)
        hits = {d["name"]: d["hits"] for d in await docs(page)}
        check(hits["report.docx"] >= 1 and hits["report.odt"] >= 1, "phrase search finds text pages")
        await page.fill("#searchInput", "ward office")
        await page.wait_for_timeout(400)
        hits = {d["name"]: d["hits"] for d in await docs(page)}
        check(hits["note.png"] >= 1, "multi-word phrase matches across OCR words")
        await page.fill("#searchInput", "")
        await page.wait_for_timeout(300)

        # ---------------------------------------------------------------- viewer
        print("Viewer")
        await page.locator(".doc-item", has_text="report.docx").click()
        await page.wait_for_timeout(300)
        z0 = await page.inner_text("#zoomFit")
        await page.click("#zoomIn")
        z1 = await page.inner_text("#zoomFit")
        check(z0 == "100%" and z1 != z0, f"zoom changes ({z0} -> {z1})")
        await page.click("#zoomFit")
        await page.locator(".doc-item", has_text="note.png").click()
        await page.wait_for_timeout(300)
        before = await page.evaluate("() => { const p = window.__scantext.state.docs.find(d=>d.name==='note.png').pages[0]; return [p.canvas.width, p.canvas.height]; }")
        await page.locator(".page-tools button[aria-label='Rotate this page']").first.click()
        await page.wait_for_function("() => !window.__scantext.state.docs.find(d=>d.name==='note.png').pages[0].busy")
        after = await page.evaluate("() => { const p = window.__scantext.state.docs.find(d=>d.name==='note.png').pages[0]; return [p.canvas.width, p.canvas.height]; }")
        check(after == [before[1], before[0]], f"rotate swaps canvas dimensions {before}->{after}")
        await page.fill("#searchInput", "")

        # ---------------------------------------------------------------- translation, online engine
        print("Translate with the online engine (consent, chunks, cache)")
        await page.locator(".doc-item", has_text="report.docx").click()
        await page.click("#translateBtn")
        await page.wait_for_timeout(300)
        await page.select_option("#tgtLang", "hi")
        await page.wait_for_function("() => /sent to/.test(document.getElementById('engineNote').textContent)", timeout=15000)
        note = await page.inner_text("#engineNote")
        check("api.mymemory.translated.net" in note, f"engine note names where text goes: '{note}'")
        await page.click("#translateDocBtn")
        await page.wait_for_selector("#consentPanel:not([hidden])")
        check(len(page.mm_requests) == 0, "nothing is sent before consent")
        await page.click("#consentNo")
        await page.wait_for_timeout(300)
        check(len(page.mm_requests) == 0, "declining sends nothing")
        await page.click("#translateDocBtn")
        await page.wait_for_selector("#consentPanel:not([hidden])")
        await page.click("#consentYes")
        await page.wait_for_function("() => { const d = window.__scantext.state.docs.find(x=>x.name==='report.docx'); return !d.tr.running && d.tr.byLang.hi && d.tr.byLang.hi.pages.filter(Boolean).length === d.pages.length; }", timeout=30000)
        check(len(page.mm_requests) > 1, f"text sent in several chunks ({len(page.mm_requests)} requests)")
        check(all(len(q["q"][0].encode()) <= 480 for q in page.mm_requests), "every request within MyMemory's 500-byte cap")
        check(all(q["langpair"][0] == "en|hi" for q in page.mm_requests), "source auto-detected as English")
        check(await page.locator(".tr-card .tr-body").first.inner_text() != "", "translation cards filled")
        await shot(page, "03-translate")
        n = len(page.mm_requests)
        await page.click("#translateDocBtn")  # nothing left → redoes all, but from cache
        await page.wait_for_function("() => !window.__scantext.state.docs.find(x=>x.name==='report.docx').tr.running")
        check(len(page.mm_requests) == n, "re-translating the same text is served from cache")

        print("Export")
        await page.click("#exportBtn")
        async with page.expect_download() as dl:
            await page.click("#exportMenu [data-action='docx-tr']")
        d = await dl.value
        check(d.suggested_filename == "report.hi.docx", f"translated docx name: {d.suggested_filename}")
        import zipfile, io
        z = zipfile.ZipFile(await d.path())
        xml = z.read("word/document.xml").decode()
        check("[en|hi]" in xml and "Translated to Hindi" in xml, "translated docx holds the translation and says what it is")
        await page.click("#exportBtn")
        async with page.expect_download() as dl:
            await page.click("#exportMenu [data-action='csv']")
        d = await dl.value
        csv_text = Path(await d.path()).read_text(encoding="utf-8")
        check(csv_text.startswith("﻿page,source,text,translation_hi"), "csv carries a translation column")
        await page.click("#exportBtn")
        async with page.expect_download() as dl:
            await page.click("#exportMenu [data-action='json']")
        j = json.loads(Path(await (await dl.value).path()).read_text(encoding="utf-8"))
        check(j["translation"]["to"] == "hi" and j["pages"][0]["translation"], "json carries translation")
        await page.click("#exportBtn")
        async with page.expect_download() as dl:
            await page.click("#exportMenu [data-action='docx']")
        d = await dl.value
        check(d.suggested_filename == "report.docx" and b"Revenue grew" in zipfile.ZipFile(await d.path()).read("word/document.xml"), "original docx export still works")

        print("Translate a selection")
        await page.locator(".doc-item", has_text="report.docx").click()
        await page.wait_for_timeout(300)
        await page.evaluate("""() => { const p = document.querySelector('.doc-pages:not([hidden]) .text-sheet p'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); }""")
        await page.wait_for_selector(".selection-bar:not([hidden])", timeout=3000)
        check(True, "selection bar appears on a text page")
        await page.click(".selection-bar [data-sel='translate']")
        await page.wait_for_function("() => document.getElementById('selResult').textContent.startsWith('[en|hi]')", timeout=15000)
        check(not await page.locator("#consentPanel:not([hidden])").count(), "consent remembered for the engine")
        await page.click("#selCopy") if await page.locator("#selCopy:visible").count() else None

        print("Settings, theme, errors")
        await page.click("#settingsBtn")
        check(await page.is_visible("#settingsPanel"), "settings opens")
        await page.fill("#langSearchInput", "hindi")
        await page.locator(".lang-option", has_text="Hindi").click()
        chips = await page.locator(".lang-chip").count()
        check(chips == 2, "adding a language shows two chips")
        await page.click("#applySettingsBtn")
        check(not await page.is_visible("#settingsPanel"), "Apply closes settings")
        await page.click("#settingsBtn"); await page.keyboard.press("Escape")
        check(not await page.is_visible("#settingsPanel"), "Escape closes settings")
        await page.click("#settingsBtn"); await page.click("#settingsPanel", position={"x": 5, "y": 5})
        check(not await page.is_visible("#settingsPanel"), "backdrop click closes settings")

        await page.click("#themeBtn")
        theme = await page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        await shot(page, "04-dark-or-light")
        await page.reload()
        theme2 = await page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        check(theme in ("light", "dark") and theme == theme2, f"theme persists across reload ({theme})")

        await page.wait_for_function("() => window.__scantext")
        await page.set_input_files("#fileInput", {"name": "old.doc", "mimeType": "application/msword", "buffer": b"x"})
        await page.wait_for_selector("#statusLine.is-warn")
        msg = await page.inner_text("#statusLine")
        check(".docx" in msg and not await page.locator(".doc-item").count(), f"legacy .doc rejected with guidance: '{msg[:70]}…'")
        await page.set_input_files("#fileInput", {"name": "broken.docx", "mimeType": "application/octet-stream", "buffer": b"not a zip at all"})
        await page.wait_for_function("() => window.__scantext.state.docs.some(d => d.status === 'error')")
        check("damaged" in (await docs(page))[0]["error"] or "valid" in (await docs(page))[0]["error"], "corrupt docx shows a readable error")
        await page.click(".doc-close")
        check(await page.locator(".doc-item").count() == 0 and await page.is_visible("#welcome"), "closing the last document returns to the welcome screen")
        check(not page.logs, f"no console errors: {page.logs[:3]}")
        await ctx.close()

        # ---------------------------------------------------------------- quota error from the online engine
        print("Online engine quota error")
        ctx, page = await new_page(browser, mm_mode="quota")
        await page.goto(BASE + "/index.html")
        await page.set_input_files("#fileInput", str(FX / "report.docx"))
        await wait_done(page, 1)
        await page.click("#translateBtn")
        await page.select_option("#tgtLang", "fr")
        await page.click("#translateDocBtn")
        await page.click("#consentYes")
        await page.wait_for_selector("#trError:not([hidden])", timeout=15000)
        err = await page.inner_text("#trError")
        check("daily limit" in err, f"quota error explained in the panel: '{err[:60]}…'")
        await ctx.close()

        # ---------------------------------------------------------------- on-device engine, no consent, selection of language pair
        print("On-device (Chrome) translator")
        ctx, page = await new_page(browser, chrome_translator=True)
        await page.goto(BASE + "/index.html")
        await page.set_input_files("#fileInput", [str(FX / "plain.txt"), str(FX / "report.odt")])
        await wait_done(page, 2)
        await page.locator(".doc-item", has_text="plain.txt").click()
        await page.click("#translateBtn")
        await page.select_option("#tgtLang", "es")
        await page.wait_for_function("() => /never leaves/.test(document.getElementById('engineNote').textContent)", timeout=15000)
        check("never leaves this computer" in await page.inner_text("#engineNote"), "engine note says text stays on device")
        await page.click("#translateDocBtn")
        await page.wait_for_function("() => { const d = window.__scantext.state.docs.find(x=>x.name==='plain.txt'); return d.tr.byLang.es && d.tr.byLang.es.pages[0]; }", timeout=15000)
        check(not await page.locator("#consentPanel:not([hidden])").count() and len(page.mm_requests) == 0, "no consent prompt and no network use")
        body = await page.locator(".tr-body").first.inner_text()
        check(body.startswith("[en>es]"), "translated through Chrome's Translator")
        same = await page.evaluate("() => document.getElementById('srcLang').value")
        await page.select_option("#srcLang", "es")
        await page.click("#translateDocBtn")
        await page.wait_for_selector("#trError:not([hidden])")
        check("already looks like" in await page.inner_text("#trError"), "same source and target language is explained")
        await ctx.close()

        # ---------------------------------------------------------------- native-text PDF and the reading cache
        print("Native-text PDF, and reopening a file uses the cache")
        ctx, page = await new_page(browser)
        tess_hits = []
        page.on("request", lambda r: tess_hits.append(r.url) if r.url.endswith(".traineddata.gz") else None)
        await page.goto(BASE + "/index.html")
        await page.set_input_files("#fileInput", [str(FX / "report.pdf"), str(FX / "scan.pdf")])
        await wait_done(page, 2)
        d = {x["name"]: x for x in await docs(page)}
        check(set(d["report.pdf"]["sources"]) == {"text"}, f"PDF with a text layer uses it, no OCR ({d['report.pdf']['sources']})")
        check("Revenue grew" in d["report.pdf"]["text"], "native PDF text extracted")
        check(d["scan.pdf"]["sources"] == ["ocr", "ocr"], "image-only PDF still goes to OCR")
        await page.locator(".doc-item", has_text="report.pdf").click()
        await page.fill("#searchInput", "revenue")
        await page.wait_for_timeout(400)
        check(await page.locator(".doc-pages:not([hidden]) .hl").count() >= 1, "search highlights words on a native PDF page")
        check(await page.locator(".doc-pages:not([hidden]) .text-layer span").count() > 5, "selectable text layer built over the page")
        first_fetches = len(tess_hits)
        check(first_fetches >= 1, f"language data fetched for the scan ({first_fetches})")
        await page.reload()
        await page.wait_for_function("() => window.__scantext")
        tess_hits.clear()
        await page.set_input_files("#fileInput", [str(FX / "scan.pdf")])
        await wait_done(page, 1)
        d2 = (await docs(page))[0]
        check("Register" in d2["text"] and d2["sources"] == ["ocr", "ocr"], "reopened scan restored from cache")
        check(len(tess_hits) == 0, "no OCR engine or language data needed the second time")
        await ctx.close()

        print("Scrambled Hindi text layer: OCR is used when Hindi is configured")
        ctx, page = await new_page(browser)
        await page.goto(BASE + "/index.html")
        await page.wait_for_function("() => window.__scantext")
        await page.evaluate("() => { window.__scantext.state.settings.ocrLangs = ['eng', 'hin']; }")
        await page.set_input_files("#fileInput", [str(FX / "report.pdf")])
        await wait_done(page, 1, timeout=240000)
        d = (await docs(page))[0]
        check(d["sources"][0] == "ocr", f"page with a split-up Devanagari text layer is read by OCR ({d['sources']})")
        check("Revenue" in d["text"], "OCR with English+Hindi still reads the English")
        check("नमस्ते" in d["text"] or "दुनिया" in d["text"], "Hindi words recovered by OCR: " + d["text"].split("First bullet")[-1][:60].replace("\n", " "))
        await ctx.close()

        # ---------------------------------------------------------------- mobile layout
        print("Mobile layout")
        ctx, page = await new_page(browser, is_mobile=True, has_touch=True, device_scale_factor=2)
        await page.set_viewport_size({"width": 390, "height": 800})
        await page.goto(BASE + "/index.html")
        await page.set_input_files("#fileInput", [str(FX / "report.docx"), str(FX / "book.xlsx")])
        await wait_done(page, 2)
        await shot(page, "05-mobile-doc")
        # In mobile emulation an overflowing page widens the layout viewport, so scrollWidth can't be
        # trusted — check where the top-bar controls actually end instead.
        right = await page.evaluate("() => Math.max(...[...document.querySelectorAll('.topbar > *:not([hidden]), .topbar-actions > *:not([hidden])')].map(e => e.getBoundingClientRect().right))")
        check(right <= 391, f"top bar fits a 390px phone (rightmost control ends at {right:.0f}px)")
        check(await page.evaluate("() => visualViewport.width") <= 391, "layout viewport stays 390px wide")
        await page.click("#translateBtn")
        await page.wait_for_timeout(400)
        await shot(page, "06-mobile-drawer")
        await ctx.close()
        await browser.close()

    print()
    print("FAILED: %d" % len(failures) if failures else "ALL CHECKS PASSED")
    for f in failures: print(" -", f)
    sys.exit(1 if failures else 0)

asyncio.run(main())
