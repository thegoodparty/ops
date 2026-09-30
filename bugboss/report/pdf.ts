// The closing report as a PDF, laid out from the Markdown `render.ts` writes.
// The Markdown is the source of truth; this is only how it is drawn.
//
// pdfkit's standard fonts, not embedded ones: they ship inside the package as
// metrics, so there is no font file to copy into the image and nothing for
// tsc to leave behind. The price is WinAnsi, and pdfkit does not refuse a
// character outside it -- it writes the low byte of the code point, so "→"
// comes out as a different, wrong glyph with nothing thrown. `encodable` is
// what stands between a post-mortem and that.

import PDFDocument from "pdfkit";
import { marked, type Token, type Tokens } from "marked";

type Doc = InstanceType<typeof PDFDocument>;

const MARGIN = 54;
const BODY_SIZE = 10;
const CODE_SIZE = 8.5;
const CELL_SIZE = 9;
const CELL_PAD = 4;
const HEADING_SIZES = [18, 15, 13, 12, 11, 11];
const INDENT = 16;
// A standard-14 Courier glyph is 600/1000 em wide, every one of them, so code
// can be hard-wrapped by count rather than measured.
const COURIER_ADVANCE = 0.6;

const FONT = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  italic: "Helvetica-Oblique",
  boldItalic: "Helvetica-BoldOblique",
  code: "Courier",
} as const;

// The cp1252 characters above 0x7F that are not Latin-1. pdfkit encodes these
// correctly; everything else outside Latin-1 it gets wrong.
const CP1252_EXTRAS = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""),
);

const SUBSTITUTES: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "⇐": "<=",
  "↑": "^",
  "↓": "v",
  "≥": ">=",
  "≤": "<=",
  "≠": "!=",
  "≈": "~",
  "✓": "[x]",
  "✔": "[x]",
  "✗": "[ ]",
  "✘": "[ ]",
  "−": "-",
  "‐": "-",
  "‑": "-",
  "′": "'",
  "″": "\"",
  "ł": "l",
  "Ł": "L",
  "đ": "d",
  "Đ": "D",
  "ı": "i",
  " ": " ",
  " ": " ",
  "​": "",
};

const inWinAnsi = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(ch);
};

/**
 * Every character either drawn as itself, spelled in ASCII, stripped of its
 * accent, or shown as `?`. Never dropped: a missing character in a quoted log
 * line reads as the log line.
 */
export const encodable = (text: string): string => {
  let out = "";
  for (const ch of text.replace(/\t/g, "    ")) {
    if (ch === "\n" || inWinAnsi(ch)) {
      out += ch;
      continue;
    }
    const substitute = SUBSTITUTES[ch];
    if (substitute !== undefined) {
      out += substitute;
      continue;
    }
    const bare = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += bare.length > 0 && [...bare].every(inWinAnsi) ? bare : "?";
  }
  return out;
};

interface Run {
  text: string;
  font: string;
}

const fontFor = (bold: boolean, italic: boolean): string =>
  bold && italic ? FONT.boldItalic : bold ? FONT.bold : italic ? FONT.italic : FONT.regular;

const inlineRuns = (
  tokens: readonly Token[] | undefined,
  bold = false,
  italic = false,
): Run[] => {
  const runs: Run[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        runs.push(...inlineRuns((token as Tokens.Strong).tokens, true, italic));
        break;
      case "em":
        runs.push(...inlineRuns((token as Tokens.Em).tokens, bold, true));
        break;
      case "del":
        runs.push(...inlineRuns((token as Tokens.Del).tokens, bold, italic));
        break;
      case "codespan":
        runs.push({ text: (token as Tokens.Codespan).text, font: FONT.code });
        break;
      case "br":
        runs.push({ text: "\n", font: fontFor(bold, italic) });
        break;
      case "link": {
        const link = token as Tokens.Link;
        runs.push(...inlineRuns(link.tokens, bold, italic));
        if (link.href && link.href !== link.text) {
          runs.push({ text: ` (${link.href})`, font: fontFor(bold, italic) });
        }
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        runs.push({ text: `[image: ${image.text || image.href}]`, font: fontFor(bold, italic) });
        break;
      }
      default: {
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested && nested.length > 0) {
          runs.push(...inlineRuns(nested, bold, italic));
        } else {
          const text = (token as { text?: string }).text ?? token.raw;
          runs.push({ text, font: fontFor(bold, italic) });
        }
      }
    }
  }
  return runs.map((run) => ({ ...run, text: encodable(run.text) }));
};

const plain = (tokens: readonly Token[] | undefined): string =>
  inlineRuns(tokens).map((run) => run.text).join("");

const bottom = (doc: Doc): number => doc.page.height - doc.page.margins.bottom;
const fullWidth = (doc: Doc): number =>
  doc.page.width - doc.page.margins.left - doc.page.margins.right;

const ensureSpace = (doc: Doc, height: number): void => {
  if (doc.y + height > bottom(doc)) doc.addPage();
};

const writeRuns = (
  doc: Doc,
  runs: readonly Run[],
  x: number,
  width: number,
  size: number,
  color = "#111111",
): void => {
  const drawn = runs.filter((run) => run.text.length > 0);
  if (drawn.length === 0) return;
  doc.fillColor(color).fontSize(size);
  drawn.forEach((run, i) => {
    const last = i === drawn.length - 1;
    doc.font(run.font);
    if (i === 0) {
      doc.text(run.text, x, doc.y, { width, continued: !last, lineGap: 1.5 });
    } else {
      doc.text(run.text, { width, continued: !last, lineGap: 1.5 });
    }
  });
  doc.x = x;
};

const hardWrap = (line: string, perLine: number): string[] => {
  if (line.length === 0) return [""];
  const pieces: string[] = [];
  const chars = [...line];
  for (let i = 0; i < chars.length; i += perLine) {
    pieces.push(chars.slice(i, i + perLine).join(""));
  }
  return pieces;
};

const writeCode = (doc: Doc, text: string, x: number, width: number): void => {
  const inner = width - 2 * CELL_PAD;
  const perLine = Math.max(1, Math.floor(inner / (CODE_SIZE * COURIER_ADVANCE)));
  const lines = encodable(text)
    .split("\n")
    .flatMap((line) => hardWrap(line, perLine));
  doc.font(FONT.code).fontSize(CODE_SIZE);
  const lineHeight = doc.currentLineHeight(true) + 1;

  let next = 0;
  while (next < lines.length) {
    ensureSpace(doc, lineHeight + 2 * CELL_PAD);
    const room = Math.floor((bottom(doc) - doc.y - 2 * CELL_PAD) / lineHeight);
    const chunk = lines.slice(next, next + Math.max(1, room));
    const height = chunk.length * lineHeight + 2 * CELL_PAD;
    const top = doc.y;
    doc.rect(x, top, width, height).fill("#f2f2f2");
    doc.fillColor("#111111").font(FONT.code).fontSize(CODE_SIZE);
    chunk.forEach((line, i) => {
      doc.text(line, x + CELL_PAD, top + CELL_PAD + i * lineHeight, { lineBreak: false });
    });
    doc.x = x;
    doc.y = top + height;
    next += chunk.length;
    if (next < lines.length) doc.addPage();
  }
  doc.moveDown(0.5);
};

const columnWidths = (doc: Doc, table: string[][], width: number): number[] => {
  const columns = table[0]?.length ?? 0;
  doc.fontSize(CELL_SIZE);
  const natural = new Array<number>(columns).fill(0);
  for (const [r, row] of table.entries()) {
    doc.font(r === 0 ? FONT.bold : FONT.regular);
    row.forEach((text, c) => {
      natural[c] = Math.max(natural[c], doc.widthOfString(text) + 2 * CELL_PAD + 1);
    });
  }
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= width) {
    const slack = width - total;
    return natural.map((w) => w + (slack * w) / total);
  }
  // Narrow columns keep their natural width; the wide ones share what is left
  // in proportion to how much they want.
  const widths = new Array<number>(columns).fill(0);
  let remaining = width;
  let open = [...natural.keys()];
  for (;;) {
    const share = remaining / open.length;
    const fitting = open.filter((c) => natural[c] <= share);
    if (fitting.length === 0) break;
    for (const c of fitting) {
      widths[c] = natural[c];
      remaining -= natural[c];
    }
    open = open.filter((c) => !fitting.includes(c));
    if (open.length === 0) return widths;
  }
  const wanted = open.reduce((sum, c) => sum + natural[c], 0);
  for (const c of open) widths[c] = (remaining * natural[c]) / wanted;
  return widths;
};

const cellHeight = (doc: Doc, text: string, width: number, bold: boolean): number => {
  doc.font(bold ? FONT.bold : FONT.regular).fontSize(CELL_SIZE);
  return doc.heightOfString(text || " ", { width: width - 2 * CELL_PAD }) + 2 * CELL_PAD;
};

const drawRow = (
  doc: Doc,
  row: readonly string[],
  widths: readonly number[],
  x: number,
  bold: boolean,
): void => {
  const height = Math.max(...row.map((text, c) => cellHeight(doc, text, widths[c], bold)));
  const top = doc.y;
  let left = x;
  row.forEach((text, c) => {
    if (bold) doc.rect(left, top, widths[c], height).fill("#e8e8e8");
    doc.lineWidth(0.5).strokeColor("#999999").rect(left, top, widths[c], height).stroke();
    doc.fillColor("#111111").font(bold ? FONT.bold : FONT.regular).fontSize(CELL_SIZE);
    doc.text(text, left + CELL_PAD, top + CELL_PAD, { width: widths[c] - 2 * CELL_PAD });
    left += widths[c];
  });
  doc.x = x;
  doc.y = top + height;
};

const writeTable = (doc: Doc, token: Tokens.Table, x: number, width: number): void => {
  const header = token.header.map((cell) => plain(cell.tokens));
  const rows = token.rows.map((row) => row.map((cell) => plain(cell.tokens)));
  // The report's key/value tables have an empty header row, which Markdown
  // requires and a reader does not need drawn.
  const hasHeader = header.some((text) => text.trim().length > 0);
  const widths = columnWidths(doc, hasHeader ? [header, ...rows] : [header.map(() => ""), ...rows], width);
  const usable = bottom(doc) - doc.page.margins.top;
  const headerHeight = hasHeader
    ? Math.max(...header.map((text, c) => cellHeight(doc, text, widths[c], true)))
    : 0;

  const startPage = (): void => {
    if (hasHeader) drawRow(doc, header, widths, x, true);
  };

  ensureSpace(doc, headerHeight + CELL_SIZE * 2 + 2 * CELL_PAD);
  startPage();
  for (const row of rows) {
    const height = Math.max(...row.map((text, c) => cellHeight(doc, text, widths[c], false)));
    if (headerHeight + height > usable) {
      // A row taller than a page cannot be drawn as a box without cutting it,
      // so it is written out as label and value, which paginates on its own.
      row.forEach((text, c) => {
        const label = hasHeader ? `${header[c]}: ` : "";
        writeRuns(doc, [{ text: label, font: FONT.bold }, { text, font: FONT.regular }], x, width, CELL_SIZE);
      });
      doc.moveDown(0.5);
      continue;
    }
    if (doc.y + height > bottom(doc)) {
      doc.addPage();
      startPage();
    }
    drawRow(doc, row, widths, x, false);
  }
  doc.moveDown(0.8);
};

const writeBlocks = (doc: Doc, tokens: readonly Token[], x: number, width: number): void => {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const size = HEADING_SIZES[heading.depth - 1] ?? BODY_SIZE;
        doc.moveDown(0.4);
        // Keep a heading with at least a few lines of what it heads.
        ensureSpace(doc, size * 1.4 + BODY_SIZE * 4);
        writeRuns(
          doc,
          inlineRuns(heading.tokens, true).map((run) => ({ ...run, font: run.font === FONT.code ? FONT.code : FONT.bold })),
          x,
          width,
          size,
        );
        doc.moveDown(0.3);
        break;
      }
      case "paragraph":
      case "text": {
        const runs = inlineRuns((token as Tokens.Paragraph).tokens ?? [{ type: "text", raw: token.raw, text: (token as Tokens.Text).text } as Token]);
        writeRuns(doc, runs, x, width, BODY_SIZE);
        if (token.type === "paragraph") doc.moveDown(0.5);
        break;
      }
      case "code":
        writeCode(doc, (token as Tokens.Code).text, x, width);
        break;
      case "table":
        writeTable(doc, token as Tokens.Table, x, width);
        break;
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const top = doc.y;
        const page = doc.page;
        writeBlocks(doc, quote.tokens, x + INDENT, width - INDENT);
        if (doc.page === page) {
          doc.lineWidth(2).strokeColor("#bbbbbb").moveTo(x + 4, top).lineTo(x + 4, doc.y - 4).stroke();
        }
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        list.items.forEach((item, i) => {
          const marker = list.ordered ? `${start + i}.` : item.task ? (item.checked ? "[x]" : "[ ]") : "•";
          ensureSpace(doc, BODY_SIZE * 1.5);
          const top = doc.y;
          doc.fillColor("#111111").font(FONT.regular).fontSize(BODY_SIZE);
          doc.text(marker, x, top, { width: INDENT + 6, lineBreak: false });
          doc.y = top;
          writeBlocks(doc, item.tokens, x + INDENT + 6, width - INDENT - 6);
        });
        doc.x = x;
        doc.moveDown(0.5);
        break;
      }
      case "hr": {
        ensureSpace(doc, 12);
        const y = doc.y + 4;
        doc.lineWidth(0.5).strokeColor("#999999").moveTo(x, y).lineTo(x + width, y).stroke();
        doc.y = y + 8;
        break;
      }
      default: {
        const text = (token as { text?: string }).text ?? token.raw;
        if (text.trim()) writeRuns(doc, [{ text: encodable(text), font: FONT.regular }], x, width, BODY_SIZE);
      }
    }
  }
};

export interface PdfOptions {
  /** Off only so a test can read the content streams. */
  compress?: boolean;
}

export const renderReportPdf = (markdown: string, options: PdfOptions = {}): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    // Pinned dates are what make the bytes a function of the input: pdfkit
    // also derives the document /ID from the info dictionary.
    const epoch = new Date(0);
    const doc = new PDFDocument({
      size: "LETTER",
      margin: MARGIN,
      compress: options.compress ?? true,
      info: { Title: "Closing report", Producer: "BugBoss", Creator: "BugBoss", CreationDate: epoch, ModDate: epoch },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      writeBlocks(doc, marked.lexer(markdown), doc.page.margins.left, fullWidth(doc));
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
