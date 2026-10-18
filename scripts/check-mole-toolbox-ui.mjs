// Real renderer/preload/IPC/workflow/task queue/process. Discovery and Trash are isolated fixtures.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import electron from 'electron'

const root = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/mole-toolbox-ui-')
try {
  const tools = join(root, 'resources/tools/darwin-arm64/mole')
  await mkdir(tools, { recursive: true })
  await writeFile(
    join(tools, 'mo'),
    String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const root = ${JSON.stringify(root)}, args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args)+'\n')
if (fs.existsSync(path.join(root, 'hold'))) { fs.writeFileSync(path.join(root,'hold-started'),String(process.pid)); setInterval(()=>{}, 1000); return }
if (fs.existsSync(path.join(root, 'fail'))) { console.error('Fixture scan failure'); process.exit(7) }
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')))
if (args[0] === 'analyze') {
  const status = fs.existsSync(path.join(root, 'partial')) ? 'partial' : 'complete'
  const folder = args[2], nested = folder.endsWith('/Projects')
  console.log(JSON.stringify({path:folder, scan_status:status, total_size:9000000, total_files:120,
    entries:nested ? [] : [
      {name:'Projects',path:path.join(root,'Projects'),size:8000000,is_dir:true,scan_status:status},
      {name:'Unknown',path:path.join(root,'Unknown'),size:0,is_dir:true,scan_status:'unavailable'},
      {name:'backup.zip',path:path.join(root,'backup.zip'),size:1000000,is_dir:false,scan_status:'complete'}
    ], large_files:[{name:'backup.zip',path:path.join(root,'backup.zip'),size:1000000,scan_status:'complete'}]
  })); return
}
if (args[0] === 'uninstall' && args[1] === '--list') { console.log(JSON.stringify(config.apps)); return }
if (!args.includes('--dry-run') || !args.includes('--debug')) process.exit(90)
if (args[0] === 'installer') for(const file of config.installer) console.log('Found installer: '+file)
else if (args[0] === 'purge') for(const file of config.purge) console.log('[DRY RUN] '+file+', '+config.purgeSizes[file])
else process.exit(91)
if (fs.existsSync(path.join(root,'truncated'))) console.log('x'.repeat(1100000))
console.log('➤ Fixture discovery\nPreview complete - no changes made')
`,
    { mode: 0o755 }
  )
  await writeFile(
    join(tools, 'arkive-uninstall-preview.sh'),
    String.raw`#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), root=${JSON.stringify(root)}
const rows=JSON.parse(fs.readFileSync(path.join(root,'uninstall.json')))
for (const line of JSON.parse(fs.readFileSync(path.join(root,'uninstall-diagnostics.json')))) console.error('ARKIVE_MOLE_DIAGNOSTIC: '+line)
process.stdout.write(['arkive-uninstall-v1',...rows.flat(),''].join('\0'))
`,
    { mode: 0o755 }
  )
  await writeFile(
    join(root, 'os-fixture.ts'),
    `export * from 'os'; export const homedir=()=>${JSON.stringify(root)}`
  )
  await writeFile(
    join(root, 'trash-fixture.ts'),
    `
import {rename, mkdir, appendFile, readFile} from 'node:fs/promises'
import {join, relative, isAbsolute, basename} from 'node:path'
const root=${JSON.stringify(root)}
export async function trashPaths(paths,signal,permanent=false) {
  if (permanent) throw Error('No permanent deletion in UI fixture')
  const completed=[]
  for(const path of paths) {
    signal?.throwIfAborted()
    const rel=relative(root,path)
    if(isAbsolute(rel)||rel.startsWith('..')) throw Error('Fixture refuses host path')
    const failures=await readFile(join(root,'trash-fail.json'),'utf8').then(JSON.parse,()=>[])
    if(failures.includes(path)) throw Error('Fixture Trash failure')
    await mkdir(join(root,'Trash'),{recursive:true})
    await rename(path,join(root,'Trash',String(Date.now())+'-'+basename(path)))
    await appendFile(join(root,'trash-calls'),path+'\\n')
    completed.push(path)
  }
  return {operation:'trash',completed,failed:[],unprocessed:[]}
}
`
  )
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: {
      alias: [
        { find: 'node:os', replacement: join(root, 'os-fixture.ts') },
        { find: '../file-operations/service', replacement: join(root, 'trash-fixture.ts') }
      ]
    },
    build: {
      ssr: true,
      target: 'node22',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve('src/main/modules/mole/toolbox-ui.test.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  const env = { ...process.env, ARKIVE_TOOLBOX_FIXTURE: root }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [join(root, 'check.cjs')], { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done() : reject(Error(`Toolbox UI failed: ${code}`))
    )
  })
  console.log(`Toolbox UI evidence: ${root}`)
} finally {
  await rm(join(root, 'resources'), { recursive: true, force: true })
}
