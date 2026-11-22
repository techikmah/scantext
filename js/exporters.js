// Builds the downloadable files. Pure functions over a plain "export model", so they
// run identically in the browser and in the Node tests:
//
//   model = {
//     name: "invoice",
//     pages: [{ page: 1, source: "ocr"|"text", title?: string, text: string,
//               words?: [{text,x0,y0,x1,y1}], translation?: string|null }],
//     translation: null | { lang: "hi", langName: "Hindi", from: "en", engine: "Chrome, on this device" },
//   }

import { Document, Paragraph, TextRun, HeadingLevel, Packer } from "./docx-loader.js";
import { csvEscape } from "./text-utils.js";
import { RTL_LANGS } from "./translate.js";

const sourceLabel = (s) => (s === "ocr" ? "OCR" : "text");

export function buildCsv(model) {
  const tr = model.translation;
  const header = ["page", "source", "text"];
  if (tr) header.push(`translation_${tr.lang}`);
  const rows = model.pages.map((p) => {
    const cols = [p.page, p.source, p.text];
    if (tr) cols.push(p.translation || "");
    return cols.map(csvEscape).join(",");
  });
  // BOM so Excel opens non-Latin text as UTF-8 instead of guessing a legacy codepage.
  return "﻿" + [header.join(","), ...rows].join("\r\n");
}

export function buildJson(model) {
  const tr = model.translation;
  return JSON.stringify(
    {
      document: model.name,
      generatedAt: new Date().toISOString(),
      ...(tr ? { translation: { to: tr.lang, from: tr.from, engine: tr.engine } } : {}),
      pages: model.pages.map((p) => ({
        page: p.page,
        ...(p.title ? { title: p.title } : {}),
        source: p.source,
        text: p.text,
        ...(tr ? { translation: p.translation || null } : {}),
        ...(p.words ? { words: p.words.map((w) => ({ text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })) } : {}),
      })),
    },
    null,
    2
  );
}

export function buildTxt(model, which = "original") {
  const parts = [];
  for (const p of model.pages) {
    const body = which === "translation" ? p.translation : p.text;
    if (which === "translation" && !body) continue;
    const head = p.title ? `${p.title}` : `Page ${p.page}`;
    parts.push(`--- ${head} ---\n${body || ""}`);
  }
  return parts.join("\n\n") + "\n";
}

function lines(text) {
  return String(text || "").split("\n");
}

// which: "original" or "translation". The translated file has the translation only —
// the original sits next to it in the CSV/JSON exports when both are wanted.
export async function buildDocxBlob(model, which = "original") {
  const tr = model.translation;
  const translated = which === "translation";
  const rtl = translated && tr && RTL_LANGS.has(tr.lang);

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.name)] }),
    new Paragraph({
      children: [
        new TextRun({
          text: translated
            ? `Translated to ${tr.langName} with ${tr.engine} — ScanText, ${new Date().toLocaleDateString()}`
            : `Extracted by ScanText, ${new Date().toLocaleDateString()}`,
          italics: true,
          size: 18,
        }),
      ],
    }),
  ];

  for (const p of model.pages) {
    const body = translated ? p.translation : p.text;
    if (translated && !body) continue;
    const label = p.title || `Page ${p.page}`;
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 300 },
        children: [
          new TextRun(label),
          ...(translated ? [] : [new TextRun({ text: `  (${sourceLabel(p.source)})`, italics: true, size: 20 })]),
        ],
      })
    );
    for (const line of lines(body)) {
      children.push(
        new Paragraph({
          bidirectional: !!rtl,
          children: [new TextRun({ text: line, rightToLeft: !!rtl })],
        })
      );
    }
  }

  return Packer.toBlob(new Document({ sections: [{ children }] }));
}

export function safeFileStem(name) {
  return String(name || "document").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "document";
}
