import { writeFile } from 'node:fs/promises'

/** Creates a small valid PDF without depending on a bundled PDF renderer. */
export async function writePdfFixture(path: string, label = 'Arkive PDF fixture'): Promise<void> {
  const text = label.replace(/[\\()]/g, '\\$&')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}endstream`
  ]
  const header = '%PDF-1.4\n%âãÏÓ\n'
  let body = header
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`
  await writeFile(path, Buffer.from(body, 'latin1'))
}
