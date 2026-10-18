// Validate the built arm64 runtime without starting a catalog against the user's archives.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const resources = resolve('dist/mac-arm64/arkive.app/Contents/Resources')
await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/packaged-runtime-')
const check = join(directory, 'check.cjs')
await writeFile(
  check,
  `
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const {pathToFileURL}=require('node:url');
const resources=${JSON.stringify(resources)}, directory=${JSON.stringify(directory)}, asar=path.join(resources,'app.asar');
(async()=>{
  assert.equal(process.arch,'arm64');
  assert.equal(JSON.parse(fs.readFileSync(path.join(asar,'package.json'),'utf8')).name,'arkive');
  assert.ok(!fs.readdirSync(asar).some(name=>name.startsWith('.env')));
  assert.ok(!fs.readdirSync(path.join(asar,'out')).some(name=>name.includes('-check-')||name.startsWith('processing-ui-')));
  const {DatabaseSync}=require('node:sqlite'), database=path.join(directory,'check.db');
  let db=new DatabaseSync(database); db.exec("CREATE TABLE runtime (value TEXT); INSERT INTO runtime VALUES ('ok')"); db.close();
  db=new DatabaseSync(database); assert.equal(db.prepare('SELECT value FROM runtime').get().value,'ok'); db.close();
  const image=path.join(directory,'generated.png');
  const sharp=require(path.join(asar,'node_modules/sharp'));
  await sharp({create:{width:32,height:32,channels:3,background:'#90ab80'}}).png().toFile(image);
  assert.equal((await sharp(image).metadata()).width,32);
  const script=path.join(resources,'finder-tags.jxa');
  const tags=(request)=>JSON.parse(cp.execFileSync('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify(request)],{encoding:'utf8',timeout:20000}));
  assert.deepEqual(tags({path:image,tags:['打包验证']}),['打包验证']);
  assert.deepEqual(tags({path:image}),['打包验证']);
  for(const [name,flag] of [['ffmpeg','-version'],['ffprobe','-version'],['qpdf/bin/qpdf','--version'],['pngquant','--version'],['ab-av1','--version'],['czkawka_cli','--version'],['arkive-apfs-dedupe','--version']]){
    const result=cp.spawnSync(path.join(resources,'tools',name),[flag],{encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,name+': '+(result.error?.message||result.stderr));
  }
  const source=path.join(directory,'clone-source'), target=path.join(directory,'clone-target');
  fs.writeFileSync(source,Buffer.alloc(1024*1024,'generated packaged clone fixture'));
  fs.writeFileSync(target,fs.readFileSync(source));
  const transaction=fs.mkdtempSync(path.join(directory,'.arkive-dedupe-'));
  const helper=(...args)=>JSON.parse(cp.execFileSync(path.join(resources,'tools/arkive-apfs-dedupe'),args,{encoding:'utf8',timeout:20000}));
  assert.equal(helper('prepare',source,target,transaction).status,'prepared');
  assert.equal(helper('commit',source,target,transaction).status,'deduplicated');
  const clones=helper('inspect',source,target);
  assert.notEqual(clones.sourceCloneId,'0'); assert.equal(clones.sourceCloneId,clones.targetCloneId);
  fs.writeFileSync(target,'independent edit');
  assert.equal(fs.statSync(source).size,1024*1024);
  fs.rmdirSync(transaction);
  const sdkRoot=path.join(asar,'node_modules/@earendil-works/pi-coding-agent');
  const sdkPackage=JSON.parse(fs.readFileSync(path.join(sdkRoot,'package.json'),'utf8'));
  const entry=path.join(sdkRoot,sdkPackage.exports['.'].import);
  const sdk=await import(pathToFileURL(entry).href);
  assert.equal(typeof sdk.createAgentSession,'function');
  console.log('PASS: packaged arm64 Electron '+process.versions.electron+', valid ASAR metadata, SQLite reopen, Sharp image, Finder tags, 8 tool binaries, real APFS clone/independent writes and Pi SDK import; no .env or temporary check artifacts. Evidence: '+directory);
})().catch(error=>{console.error(error);process.exitCode=1});
`
)
await new Promise((done, reject) => {
  const child = spawn(resolve('dist/mac-arm64/arkive.app/Contents/MacOS/arkive'), [check], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  })
  child.on('error', reject)
  child.on('close', (code, signal) => {
    if (code === 0 && !signal) done()
    else reject(new Error(`Packaged runtime failed: ${code ?? signal}`))
  })
})
