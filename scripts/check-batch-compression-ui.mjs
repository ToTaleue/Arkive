// Focused renderer regression: controlled IPC results, no compression/model acceptance credit.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'electron'

const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/batch-result-ui-')
const source = resolve('src/renderer/src/components/CompressionPage.tsx')
await writeFile(
  join(directory, 'index.html'),
  '<div id="root"></div><script type="module" src="/renderer.tsx"></script>'
)
await writeFile(
  join(directory, 'renderer.tsx'),
  `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CompressionPage} from ${JSON.stringify(source)}; createRoot(document.getElementById('root')).render(<CompressionPage/>);`
)
await writeFile(
  join(directory, 'preload.cjs'),
  `
const {contextBridge}=require('electron');
const quality={metric:'ssimulacra2',targetScore:90,score:82.07,attempts:1,meetsTarget:false};
let index=0;
const requests=[];
const results=[
 {status:'compressed',archive:{status:'ready',item:{tagStatus:'synced'}},automaticTags:{status:'error',error:'无法连接模型服务'},qualityAnalysis:quality},
 {status:'no-savings',qualityAnalysis:{...quality,score:null,meetsTarget:null,error:'metric unavailable'}},
 {status:'compressed',archive:{status:'error',error:'目标目录不可写'},qualityAnalysis:quality},
 {status:'compressed',archive:{status:'ready',item:{tagStatus:'error',tagError:'Finder 写入失败'}},automaticTags:{status:'ready',tags:['毕业照']},qualityAnalysis:quality},
 {status:'compressed',archive:{status:'ready',item:{tagStatus:'synced',originalLink:{status:'error',error:'原位置已被占用，未覆盖。'}}},qualityAnalysis:quality}
];
contextBridge.exposeInMainWorld('api',{
 testRequests:async()=>requests,
 processing:{
   localFilePath:f=>f.name,
   selectPath:async(kind,path)=>({id:path,kind}),
   compress:async request=>{
     requests.push({kind:'document',...request});
     return {
       status:'completed',
       result:{
         kind:request.fileId.endsWith('.pdf')?'pdf':'office',
         value:{status:'compressed',originalBytes:4096,inputBytes:4096,outputBytes:1024,
           media:[],archive:{status:'ready',item:{tagStatus:'synced'}}}
       }
     };
   }
 },
 tasks:{list:async()=>[],onChanged:()=>()=>{}},
 video:{
   selectPath:async path=>({id:path}),
   compress:async request=>{
     requests.push({kind:'video',...request});
     return {status:'completed',result:{status:'compressed',inputBytes:4096,outputBytes:1024,
       qualityAnalysis:{sampleVmaf:95,targetVmaf:90},
       archive:{status:'ready',item:{tagStatus:'synced',originalLink:{status:'ready'}}}}};
   }
 },
 image:{selectPath:async path=>({id:path}),compress:async request=>{requests.push({kind:'image',...request});return {status:'completed',result:{originalBytes:14088013,outputBytes:4187597,...results[index++]}}}}
});
`
)
await build({
  configFile: false,
  base: './',
  root: directory,
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { react: resolve('node_modules/react'), 'react-dom': resolve('node_modules/react-dom') }
  },
  build: { outDir: join(directory, 'renderer'), emptyOutDir: true }
})
await writeFile(
  join(directory, 'main.cjs'),
  `
const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {writeFile}=require('node:fs/promises');
app.on('window-all-closed',()=>{});
(async()=>{await app.whenReady();const w=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))}}});w.webContents.on('console-message',e=>console.log('renderer:',e.message));
try{await w.loadFile(${JSON.stringify(join(directory, 'renderer/index.html'))});const ev=s=>w.webContents.executeJavaScript(s);
const readyEnd=Date.now()+5000;while(!await ev("!!document.querySelector('.compression-drop')")){assert.ok(Date.now()<readyEnd,'renderer did not mount');await new Promise(r=>setTimeout(r,30));}
const option=text=>"[...document.querySelectorAll('.compression-confirm')].find(l=>l.querySelector('span')?.textContent==="+JSON.stringify(text)+").querySelector('input')";
const archiveOption=option('压缩完成后归档');const linkOption=option('在原位置保留访问入口（试用）');
assert.equal(await ev(linkOption+'.disabled'),true);await ev(archiveOption+'.click()');await ev(linkOption+'.click()');assert.equal(await ev(linkOption+'.checked'),true);
await ev(archiveOption+'.click()');assert.equal(await ev(linkOption+'.disabled'),true);assert.equal(await ev(linkOption+'.checked'),false);
await ev(archiveOption+'.click()');await ev(linkOption+'.click()');
await writeFile(${JSON.stringify(join(directory, 'options.png'))},(await w.webContents.capturePage()).toPNG());
await ev("(()=>{const dt=new DataTransfer();for(const name of ['case-0.jpg','case-1.jpg','case-2.jpg','case-3.jpg','case-4.jpg','video.mp4','document.pdf','slides.pptx'])dt.items.add(new File(['x'],name));document.querySelector('.compression-drop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));})()");
await new Promise(r=>setTimeout(r,100));await ev("[...document.querySelectorAll('.compression-confirm')].find(l=>l.textContent.includes('Office 压缩')).querySelector('input').click()");
await new Promise(r=>setTimeout(r,100));await ev("document.querySelector('.compression-primary').click()");
const end=Date.now()+5000;while(!await ev("document.querySelectorAll('.compression-status.done').length===8")){assert.ok(Date.now()<end,'batch did not finish');await new Promise(r=>setTimeout(r,30));}
const rows=await ev("[...document.querySelectorAll('.compression-row')].map(r=>r.innerText)");await writeFile(${JSON.stringify(join(directory, 'rows.json'))},JSON.stringify(rows,null,2));
const requests=await ev('window.api.testRequests()');assert.equal(requests.length,8);assert.ok(requests.every(r=>r.archive===true&&r.keepLinkAtOriginalLocation===true));
await writeFile(${JSON.stringify(join(directory, 'requests.json'))},JSON.stringify(requests,null,2));
const checks=[['AI failure',rows[0].includes('AI 标签失败')&&rows[0].includes('无法连接模型服务')],['advisory quality',rows[0].includes('82.1')&&rows[0].includes('90')],['measured size',rows[0].includes('70.3%')],['no savings',rows[1].includes('无压缩收益')],['archive failure',rows[2].includes('归档失败')&&rows[2].includes('目标目录不可写')],['Finder failure',rows[3].includes('Finder')&&rows[3].includes('失败')]];
checks.push(['link conflict visible',rows[4].includes('原位置入口未创建')&&rows[4].includes('占用')]);checks.push(['link success visible',rows[5].includes('原位置入口已创建')]);
checks.push(['pre-compression choice reaches image/video/PDF/Office',requests.some(r=>r.kind==='video')&&requests.filter(r=>r.kind==='document').length===2]);
for(let n=0;n<2;n++){await ev("(()=>{const dt=new DataTransfer();for(let i=0;i<2;i++)dt.items.add(new File(['x'],'folder-'+i+'.jpg'));const input=document.querySelector('input[directory]');Object.defineProperty(input,'files',{value:dt.files,configurable:true});input.dispatchEvent(new Event('change',{bubbles:true}));})()");await new Promise(r=>setTimeout(r,50));}
checks.push(['same folder reselect',await ev("document.querySelectorAll('.compression-row').length===2")]);
for(const [name,pass]of checks)console.log((pass?'PASS: ':'FAIL: ')+name);
assert.ok(checks.every(([,pass])=>pass),'completed rows hide result details');
console.log('PASS: real CompressionPage displays partial failures, no savings, sizes and advisory quality. Evidence: '+${JSON.stringify(directory)});
}finally{w.destroy();}})().then(()=>app.exit(0),e=>{console.error(e);app.exit(1)});
`
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const code = await new Promise((done, reject) => {
  const child = spawn(
    electron,
    [join(directory, 'main.cjs'), `--user-data-dir=${join(directory, 'state')}`],
    { env, stdio: 'inherit' }
  )
  child.on('error', reject)
  child.on('exit', done)
})
assert.equal(code, 0, `Renderer regression failed; evidence: ${directory}`)
