import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import type { OfficeFormat } from '../../../shared/contracts/office'

const relNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const relType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'

function wordPictures(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<w:p><w:r><w:drawing><wp:inline>
    <wp:extent cx="1828800" cy="1828800"/><wp:docPr id="${String(index + 1)}" name="Image ${String(index)}"/>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
    <pic:nvPicPr><pic:cNvPr id="${String(index + 1)}" name="Image ${String(index)}"/><pic:cNvPicPr/></pic:nvPicPr>
    <pic:blipFill><a:blip r:embed="img${String(index)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
    <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
    </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  ).join('')
}

function slidePictures(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<p:pic>
    <p:nvPicPr><p:cNvPr id="${String(index + 2)}" name="Image ${String(index)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
    <p:blipFill><a:blip r:embed="img${String(index)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
    <p:spPr><a:xfrm><a:off x="${String(914400 + index * 2743200)}" y="914400"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>`
  ).join('')
}

export async function fixture(
  path: string,
  format: OfficeFormat,
  images: Buffer[],
  options: {
    missingTarget?: boolean
    signed?: boolean
    duplicate?: boolean
    thumbnail?: Buffer
    video?: Buffer
  } = {}
): Promise<void> {
  const word = format === 'docx'
  const main = word ? 'word/document.xml' : 'ppt/presentation.xml'
  const owner = word ? main : 'ppt/slides/slide1.xml'
  const root = word ? 'word' : 'ppt'
  const type = word ? 'wordprocessingml.document' : 'presentationml.presentation'
  const entries: [string, Buffer | string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="${typesNamespace}">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>
      <Default Extension="gif" ContentType="image/gif"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bin" ContentType="application/octet-stream"/>
      <Default Extension="mp4" ContentType="video/mp4"/>
      <Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>
      ${word ? '' : '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'}
      </Types>`
    ],
    [
      '_rels/.rels',
      `<Relationships xmlns="${relNamespace}"><Relationship Id="rId1" Type="${relType}/officeDocument" Target="${main}"/></Relationships>`
    ],
    [
      main,
      word
        ? `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${relType}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Arkive 中文内容 &amp; preserved layout</w:t></w:r></w:p>${wordPictures(images.length)}</w:body></w:document>`
        : `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${relType}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
    ],
    [`${root}/embeddings/object1.bin`, Buffer.from('embedded object must remain unchanged')]
  ]
  if (options.thumbnail) entries.push(['docProps/thumbnail.jpeg', options.thumbnail])
  if (!word) {
    entries.push([
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${relNamespace}"><Relationship Id="rId1" Type="${relType}/slide" Target="slides/slide1.xml"/></Relationships>`
    ])
    entries.push([
      owner,
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relType}"><p:cSld name="Arkive test"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${slidePictures(images.length)}</p:spTree></p:cSld></p:sld>`
    ])
  }
  const ownerRels = word ? 'word/_rels/document.xml.rels' : 'ppt/slides/_rels/slide1.xml.rels'
  const targets = images
    .map(
      (_, i) =>
        `<Relationship Id="img${String(i)}" Type="${relType}/image" Target="${word ? '' : '../'}media/image${String(i)}.${i === 0 ? 'png' : 'jpg'}"/>`
    )
    .join('')
  entries.push([
    ownerRels,
    `<Relationships xmlns="${relNamespace}">${targets}
    <Relationship Id="external" Type="${relType}/image" TargetMode="External" Target="https://example.invalid/do-not-fetch.png"/>
    ${options.video ? `<Relationship Id="movie" Type="${relType}/video" Target="${word ? '' : '../'}media/movie.mp4"/>` : ''}
    ${options.missingTarget ? `<Relationship Id="missing" Type="${relType}/image" Target="missing.png"/>` : ''}
    </Relationships>`
  ])
  for (const [i, image] of images.entries())
    entries.push([`${root}/media/image${String(i)}.${i === 0 ? 'png' : 'jpg'}`, image])
  if (options.video) entries.push([`${root}/media/movie.mp4`, options.video])
  if (images.length)
    entries.push([
      `${root}/media/animation.gif`,
      Buffer.from('GIF89a unchanged unsupported fixture')
    ])
  if (options.signed) entries.push(['_xmlsignatures/sig1.xml', '<Signature/>'])
  if (options.duplicate) entries.push([main, '<duplicate/>'])
  const zip = new ZipFile()
  const output = createWriteStream(path, { flags: 'wx' })
  const writing = pipeline(zip.outputStream, output)
  zip.on('error', (error: Error) => {
    output.destroy(error)
  })
  for (const [name, data] of entries)
    zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name, { compress: false })
  zip.end()
  await writing
}
