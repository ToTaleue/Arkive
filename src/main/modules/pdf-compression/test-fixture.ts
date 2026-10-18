import { writeFile } from 'node:fs/promises'

async function writeObjects(path: string, objects: string[]): Promise<void> {
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
  await writeObjects(path, objects)
}

/** Creates the empty AcroForm dictionary that triggered the false positive. */
export async function writePdfFixtureWithEmptyAcroForm(
  path: string,
  label = 'Arkive empty AcroForm fixture'
): Promise<void> {
  const text = label.replace(/[\\()]/g, '\\$&')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`
  await writeObjects(path, [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}endstream`,
    '<< /Fields [] /DA (/Helv 0 Tf 0 g) >>'
  ])
}

/** Creates a minimal interactive text field for the unsupported-feature guard. */
export async function writePdfFixtureWithTextField(
  path: string,
  label = 'Arkive text field fixture'
): Promise<void> {
  const text = label.replace(/[\\()]/g, '\\$&')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`
  await writeObjects(path, [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}endstream`,
    '<< /Fields [7 0 R] /DA (/Helv 0 Tf 0 g) >>',
    '<< /FT /Tx /Type /Annot /Subtype /Widget /T (name) /Rect [72 680 240 710] /V (value) /DA (/Helv 12 Tf 0 g) /P 3 0 R >>'
  ])
}
