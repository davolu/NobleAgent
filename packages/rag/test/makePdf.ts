/**
 * Minimal single-font PDF writer for test fixtures: one content stream per
 * page, Helvetica, uncompressed, with a correct xref table. Enough for
 * pdf-parse/pdfjs to extract text with page boundaries.
 */
export function makePdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageCount = pages.length;
  const fontObjNum = 3 + pageCount * 2;

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`); // 1
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`); // 2

  pages.forEach((lines, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`
    );
    const ops = lines
      .map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 18} Td (${escapePdf(line)}) Tj ET`)
      .join("\n");
    objects.push(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
  });

  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`); // font

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function escapePdf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
