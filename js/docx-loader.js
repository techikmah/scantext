// One place that knows where the bundled docx library lives, so other modules (and
// tests) import it by a stable path.
export { Document, Paragraph, TextRun, HeadingLevel, Packer } from "../lib/docx/docx.mjs";
