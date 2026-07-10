/**
 * Minimal, valid PDFs with one line of text per page.
 *
 * Hand-built rather than committed as fixtures so the byte offsets stay correct
 * when the text changes, and so the tests read as data rather than binary blobs.
 */
export function simplePdfBuffer(text: string): Buffer {
  return multiPagePdfBuffer([text]);
}

export function multiPagePdfBuffer(pageTexts: string[]): Buffer {
  const pageCount = pageTexts.length;
  // Object ids: 1 catalog, 2 pages, 3 font, then per page a page object and a
  // content stream.
  const pageObjectId = (index: number) => 4 + index * 2;
  const contentObjectId = (index: number) => 5 + index * 2;

  const kids = pageTexts.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  for (const [index, text] of pageTexts.entries()) {
    const escapedText = text.replace(/[()\\]/g, value => `\\${value}`);
    const stream = `BT /F1 18 Tf 32 90 Td (${escapedText}) Tj ET`;
    objects.push(
      `${pageObjectId(index)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId(index)} 0 R >>\nendobj\n`,
      `${contentObjectId(index)} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\n` +
        `stream\n${stream}\nendstream\nendobj\n`,
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

/**
 * A page that draws a filled rectangle and no text at all: what a scanned
 * document looks like to pdfjs, which finds no text layer to extract.
 */
export function imageOnlyPdfBuffer(): Buffer {
  const stream = '0.2 0.2 0.2 rg 40 40 280 100 re f';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}
