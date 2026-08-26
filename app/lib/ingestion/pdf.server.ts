// PDF text extraction for `file` data sources (spec 04).
//
// Spec 04 shipped with PDF deferred ("PDF/DOCX parser deferred — dependency
// decision needed"); this closes the PDF half. Text-layer only: a scanned PDF
// carries no text, and OCR stays out of scope (spec 04 §Out of scope), so an
// image-only file is reported as such instead of silently ingesting nothing.
//
// `unpdf` is used rather than pdf-parse/pdfjs-dist directly: it ships a
// serverless build of PDF.js with no worker thread, no DOM and no native
// binary, which is what lets this run inside the pg-boss job on any host.

/** Below this, a "PDF" is almost certainly scanned images, not a text layer. */
const MIN_TEXT_CHARS = 24;

export interface PdfText {
  text?: string;
  parseError?: string;
  pages?: number;
}

export async function extractPdfText(bytes: Buffer): Promise<PdfText> {
  let getDocumentProxy: typeof import("unpdf").getDocumentProxy;
  let extractText: typeof import("unpdf").extractText;
  try {
    // Imported lazily so scripts that never touch files don't pay for it and
    // an install without the dependency still runs everything else.
    ({ getDocumentProxy, extractText } = await import("unpdf"));
  } catch {
    return { parseError: "PDF support is not installed on this server" };
  }

  try {
    // A copy: PDF.js transfers/detaches the buffer it is handed, and `bytes`
    // may be a view into a pooled Node Buffer that the caller still holds.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : text) ?? "";
    const cleaned = normalizePdfText(merged);
    if (cleaned.length < MIN_TEXT_CHARS) {
      return {
        parseError:
          "No selectable text found — scanned or image-only PDFs aren't supported (try a text PDF)",
        pages: totalPages,
      };
    }
    return { text: cleaned, pages: totalPages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      return { parseError: "This PDF is password-protected — remove the password and re-upload" };
    }
    return { parseError: `Couldn't read this PDF (${message.slice(0, 120)})` };
  }
}

/** PDF.js emits per-glyph runs, so raw output is full of stray whitespace and
 *  hyphenated line breaks that would otherwise land in the embeddings. */
export function normalizePdfText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Soft hyphen at a line break: "ship-\nping" -> "shipping".
    .replace(/(\w)-\n(\w)/g, "$1$2")
    // Collapse runs of spaces/tabs but keep paragraph breaks — the chunker
    // splits on them.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
