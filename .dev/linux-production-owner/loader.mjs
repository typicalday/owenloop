// This loader is a separately pinned first-entry platform trust boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks, syncBuiltinESMExports, builtinModules } from 'node:module';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
function need(v){if(!v)refused('SHAPE');}
function same(a,b){return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);}
export function readFixed(relative,cap=65536,bucket='modules'){
 need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.split('/').includes('..'));
 const p=path.join(root,relative);let fd,failed=false,value;
 try{
  fd=originals.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const a=fs.fstatSync(fd,{bigint:true});need(a.isFile()&&a.nlink===1n&&a.uid===BigInt(process.getuid())&&a.size>=0n&&a.size<=BigInt(cap));
  need(Number(a.size)<=(relative==='node'?134217728-ownNodeBytes:bucket==='compiler'?67108864-compilerBytes:33554432-loadedBytes));
  const b=Buffer.alloc(Number(a.size)+1);let n=0;
  while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,null);if(!k)break;n+=k;if(relative==='node'){ownNodeBytes+=k;if(ownNodeBytes>134217728)refused('CAP');}else count(k,bucket==='compiler');}
  need(n===Number(a.size)&&same(a,fs.fstatSync(fd,{bigint:true}))&&same(a,fs.lstatSync(p,{bigint:true})));
  value=b.subarray(0,n);
 }catch(e){failed=true;value=e;}
 if(fd!==undefined)try{fs.closeSync(fd);}catch{refusal='CLEANUP';throw Object.assign(new Error('SOURCE_CLEANUP'),{code:'CLEANUP'});}
 if(failed){const expectedMissing=(relative.startsWith('entry-results/')||relative.startsWith('gates/'))&&value?.code==='ENOENT';if(!expectedMissing&&refusal!=='CLEANUP')refusal='SHAPE';throw value;}return value;
}
export function jsonFixed(relative){
 const raw=readFixed(relative,1048576),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 need(Buffer.from(JSON.stringify(v)+'\n').equals(raw));return v;
}
export function writeFixed(relative,value){
 need(['entry-results/ready.json','entry-results/positive.json','entry-results/parse.json','own-metadata.json','compiler-result.json'].includes(relative)||/^integrity-results\/(compiler|fixture|positiveRole|parserRole|supervisor|provider)\.json$/.test(relative));
 const raw=Buffer.from(JSON.stringify(value)+'\n');need(raw.length<=65536);
 const fd=originals.openSync(path.join(root,relative),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 let failed=false;
 try{let n=0;while(n<raw.length){const k=fs.writeSync(fd,raw,n,raw.length-n);need(k>0);n+=k;}fs.fsyncSync(fd);}catch(e){failed=e;}
 try{fs.closeSync(fd);}catch{refusal='CLEANUP';throw Object.assign(new Error('SOURCE_CLEANUP'),{code:'CLEANUP'});}
 if(failed)throw failed;
}
let hook,everInstalled=false,profile,refusal=null,loadedBytes=0,compilerBytes=0,ownNodeBytes=0,addonPasses=0,nodeEntrants=0;
const originals={openSync:fs.openSync,readFileSync:fs.readFileSync,readFile:fs.promises.readFile,spawn:cp.spawn,execFileSync:cp.execFileSync,createHash:crypto.createHash};
const limits={compiler:{addons:0,children:0},fixture:{addons:2,children:2},positiveRole:{addons:1,children:1},parserRole:{addons:1,children:0},supervisor:{addons:1,children:1},provider:{addons:0,children:0}};
let rows=new Map(),catalogRows=new Map(),compilerCache=new Map(),addonPath,supervisorSource;
const builtins=new Set(builtinModules.map(s=>s.replace(/^node:/,'')));
export function declareSupervisor(source){need(profile==='positiveRole'&&supervisorSource===undefined&&typeof source==='string'&&source.length<=65536);supervisorSource=source;}
function refused(code='SHAPE'){if(refusal!=='CLEANUP')refusal=code;throw Object.assign(new Error('SOURCE_REFUSED'),{code});}
export function assertPolicy(){if(refusal!==null)refused(refusal);}
function count(n,compiler=false){need(Number.isSafeInteger(n)&&n>=0);if(compiler){compilerBytes+=n;if(compilerBytes>67108864)refused('CAP');}else{loadedBytes+=n;if(loadedBytes>33554432)refused('CAP');}}
function relative(p){
 if(p instanceof URL)p=fileURLToPath(p);
 if(typeof p!=='string')return refused('ARGUMENT');
 const absolute=path.resolve(p),rel=path.relative(root,absolute).split(path.sep).join('/');
 if(rel==='..'||rel.startsWith('../')||path.isAbsolute(rel))return null;
 return rel;
}
function checkedRawPath(p){
 const rel=relative(p);if(rel===null){if(p===addonPath||p==='/bin/ps'||p==='/usr/bin/ps'||(typeof p==='string'&&p.startsWith('/proc/self/')))return;return refused('SHAPE');}
 if((profile==='compiler'&&(rel==='compiler-result.json'||rel.startsWith('dist/')))||rows.has(rel)||['node','runtime-closure.json','original-catalog.json','binding.json'].includes(rel)||rel.startsWith('entry-results/')||rel.startsWith('gates/')||rel.startsWith('integrity-results/'))return;
 return refused('SHAPE'); // Includes metadata-only original inputs, never ENOENT substitution.
}
function checkAddon(p){if(p===addonPath){addonPasses++;if(addonPasses>limits[profile].addons)refused('CAP');}}
function checkedRawRead(p,options){
 checkedRawPath(p);const rel=relative(p);
 if(rel!==null&&rows.has(rel)){
  const row=rows.get(rel),raw=readFixed(rel,16777216);
  need(raw.length===row.bytes&&originals.createHash('sha256').update(raw).digest('hex')===row.sha256);
  const encoding=typeof options==='string'?options:options?.encoding;
  if(encoding===undefined||encoding===null)return raw;
  need(typeof encoding==='string'&&Buffer.isEncoding(encoding));return raw.toString(encoding);
 }
 // Named dynamic gate/notification/proc resources keep their original source
 // semantics, with a bounded actual read charge and no inventory authority.
 let fd,failed,value;try{fd=originals.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const chunks=[];let n=0;for(;;){const b=Buffer.alloc(8192),k=fs.readSync(fd,b);if(!k)break;count(k);n+=k;need(n<=65536);chunks.push(b.subarray(0,k));}value=Buffer.concat(chunks);}catch(e){failed=e;}if(fd!==undefined)try{fs.closeSync(fd);}catch{refusal='CLEANUP';throw Object.assign(new Error('SOURCE_CLEANUP'),{code:'CLEANUP'});}if(failed){if(refusal!=='CLEANUP')refusal='SHAPE';throw failed;}const encoding=typeof options==='string'?options:options?.encoding;if(encoding===undefined||encoding===null)return value;need(typeof encoding==='string'&&Buffer.isEncoding(encoding));return value.toString(encoding);
}
function runtimeAllowed(rel){
 if(rel.startsWith('node_modules/'))return profile==='compiler'?rel.startsWith('node_modules/typescript/'):rel.startsWith('node_modules/semver/')||rel.startsWith('node_modules/yaml/')||rel.startsWith('node_modules/@cfworker/json-schema/');
 return true;
}
export function install(which){
 if(everInstalled)refused('DUPLICATE');everInstalled=true;
 need(process.platform==='linux'&&process.versions.node==='22.23.0'&&typeof registerHooks==='function'&&Object.hasOwn(limits,which));profile=which;
 need(process.permission&&process.permission.has('worker')===false);
 const closure=jsonFixed('runtime-closure.json');need(closure.protocol==='jev-production-runtime-closure-v1'&&closure.files.length<=16384);
 for(const r of closure.files){need(Object.keys(r).sort().join(',')==='bytes,format,relative,sha256');need(typeof r.relative==='string'&&!r.relative.startsWith('/')&&!r.relative.split('/').includes('..')&&!rows.has(r.relative));need(/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=536870912&&['module','commonjs','json','resource'].includes(r.format));rows.set(r.relative,r);}
 const catalog=jsonFixed('original-catalog.json');need(Object.keys(catalog).sort().join(',')==='entries,links,logicalStorageBytes,metadataOps,protocol,selected,selectedBytes,snapshotOnly'&&catalog.protocol==='jev-selected-original-catalog-v1'&&catalog.snapshotOnly===true&&Array.isArray(catalog.entries)&&catalog.entries.length<=32768&&Array.isArray(catalog.links)&&catalog.links.length<=32768&&Array.isArray(catalog.selected)&&catalog.selected.length<=16384);for(const r of catalog.entries){need(Array.isArray(r)&&r.length===3&&typeof r[0]==='string'&&Buffer.byteLength(r[0])<=4096&&!path.isAbsolute(r[0])&&!r[0].split('/').includes('..')&&!catalogRows.has(r[0])&&['DIRECTORY','LINK','CONTENT','METADATA_ONLY'].includes(r[1])&&Number.isSafeInteger(r[2])&&r[2]>=0);catalogRows.set(r[0],r);}for(const r of catalog.links)need(Array.isArray(r)&&r.length===3&&r.every(x=>typeof x==='string')&&catalogRows.get(r[0])?.[1]==='LINK'&&!path.isAbsolute(r[1])&&!r[1].split('/').includes('..'));
 const bind=jsonFixed('binding.json');addonPath=bind.artifact;
 // Public JS wrappers enforce the trusted private source roster, not a hostile-code sandbox.
 fs.openSync=function(p,flags,...rest){checkedRawPath(p);checkAddon(p);return Reflect.apply(originals.openSync,fs,[p,flags,...rest]);};
 fs.readFileSync=function(p,...rest){return checkedRawRead(p,rest[0]);};
 fs.promises.readFile=async function(p,...rest){return checkedRawRead(p,rest[0]);};
 for(const name of ['exec','execFile','fork','spawnSync','execSync'])cp[name]=()=>refused('SHAPE');
 fs.readFile=function(p,options,callback){if(typeof options==='function'){callback=options;options=undefined;}need(typeof callback==='function');queueMicrotask(()=>{let v,e;try{v=checkedRawRead(p,options);}catch(error){e=error;}if(e)callback(e);else callback(null,v);});};
 fs.createReadStream=()=>refused('SHAPE');
 fs.open=()=>refused('SHAPE');fs.promises.open=async()=>refused('SHAPE');
 cp.spawn=function(command,args,options){
  if(command!==process.execPath)refused('SHAPE');nodeEntrants++;if(nodeEntrants>limits[profile].children)refused('CAP');
  if(!Array.isArray(args))refused('SHAPE');
  if(profile==='fixture')need(args[0]===bind.roleEntry||args[0]===bind.privateEntry);
  else if(profile==='positiveRole')need(args[0]==='-e'&&args[1]===supervisorSource);
  else if(profile==='supervisor')need(args.length===1&&args[0]===bind.provider);
  else refused('SHAPE');
  if(profile==='supervisor'){need(options&&typeof options.env==='object');options={...options,env:{...options.env,NODE_OPTIONS:privateNodeOptions('provider')}};}
  return Reflect.apply(originals.spawn,cp,[command,args,options]);
 };
 cp.execFileSync=function(command,args,...rest){
  if(profile!=='supervisor'||!['/bin/ps','/usr/bin/ps'].includes(command)||JSON.stringify(args)!==JSON.stringify(['-o','pgid=','-p',String(process.pid)]))refused('SHAPE');
  return Reflect.apply(originals.execFileSync,cp,[command,args,...rest]);
 };
 crypto.createHash=function(...args){const h=Reflect.apply(originals.createHash,crypto,args),update=h.update;h.update=function(value,encoding){const n=typeof value==='string'?Buffer.byteLength(value,encoding):ArrayBuffer.isView(value)?value.byteLength:refused('ARGUMENT');count(n);return Reflect.apply(update,h,[value,encoding]);};return h;};
 process.emitWarning=()=>refused('SHAPE'); // Pending source-defined initialization warnings remain retained by Node.
 syncBuiltinESMExports();
 hook=registerHooks({resolve(specifier,ctx,next){
  if(builtins.has(specifier.replace(/^node:/,''))){if(['worker_threads','cluster','vm'].includes(specifier.replace(/^node:/,'')))refused('SHAPE');return next(specifier,ctx);}
  let r;try{r=next(specifier,ctx);}catch(e){refused('SHAPE');}
  const u=new URL(r.url);if(u.protocol!=='file:'||u.search||u.hash)refused('SHAPE');
  const rel=relative(fileURLToPath(u));if(rel===null||!rows.has(rel)||!runtimeAllowed(rel))refused('SHAPE');return r;
 },load(url,ctx,next){
  if(builtins.has(url.replace(/^node:/,'')))return next(url,ctx);
  const parsed=new URL(url);need(parsed.protocol==='file:'&&!parsed.search&&!parsed.hash);
  const absolute=fileURLToPath(parsed),rel=path.relative(root,absolute).split(path.sep).join('/');need(absolute===path.join(root,rel));
  const r=rows.get(rel);if(!r||r.format==='resource'||!runtimeAllowed(rel))refused('SHAPE');
  // Use original open: wrappers classify public consumer calls, not this reader.
  const raw=readFixed(rel,16777216);
  need(raw.length===r.bytes&&originals.createHash('sha256').update(raw).digest('hex')===r.sha256);
  return {format:r.format,source:raw,shortCircuit:true};
 }});
 process.once('exit',()=>{try{finishIntegrity();}catch{process.exitCode=2;}});
}
export function compilerRead(rel){
 try{assertPolicy();if(profile!=='compiler')refused('SHAPE');const r=rows.get(rel);if(!r)refused('SHAPE');
 if(compilerCache.has(rel))return compilerCache.get(rel);
 const raw=readFixed(rel,16777216,'compiler');need(raw.length===r.bytes&&originals.createHash('sha256').update(raw).digest('hex')===r.sha256);
 compilerCache.set(rel,raw);return raw;
 }catch(e){if(refusal!=='CLEANUP')refusal='SHAPE';throw e;}
}
let finished=false;
function finishIntegrity(){
 if(finished)return;finished=true;
 writeFixed('integrity-results/'+profile+'.json',{protocol:'jev-selected-process-integrity-v1',profile,moduleBytes:loadedBytes,compilerBytes,ownNodeBytes,addonPasses,nodeEntrants,refusal,workerDenied:true,lifetimeInstallCount:1});
}
export function uninstall(){assertPolicy();/* Hooks deliberately survive until original exit: no reset/unhooked tail. */}
export function privateNodeOptions(which,heap=192){
 need(Object.hasOwn(limits,which));const b=binding();
 const flags=['--max-old-space-size='+heap,'--permission','--allow-fs-read='+JSON.stringify(root),'--allow-fs-read='+JSON.stringify(b.artifact),'--allow-fs-read=/proc/self','--allow-fs-read=/bin/ps','--allow-fs-read=/usr/bin/ps',...['entry-results','gates','integrity-results','warnings','own-metadata.json'].map(p=>'--allow-fs-write='+JSON.stringify(path.join(root,p))),'--redirect-warnings='+JSON.stringify(path.join(root,'warnings',which+'.txt'))];
 if(limits[which].addons)flags.push('--allow-addons');if(limits[which].children)flags.push('--allow-child-process');
 if(which==='supervisor'||which==='provider')flags.push('--import='+JSON.stringify(path.join(root,'initializer.mjs')));
 return flags.join(' ');
}
export function binding(){return jsonFixed('binding.json');}
export function fixed(error){try{const d=Object.getOwnPropertyDescriptor(error,'code');if(d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP','CLOSED','COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP','PAIR','SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN','FIXTURE'].includes(d.value))return d.value;}catch{}return 'UNKNOWN';}

export async function measureOwn(){
 const m=await import('./metadata.mjs');
 function ownRead(p){let fd,result,failed=false;try{fd=originals.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const chunks=[];let n=0;for(;;){const b=Buffer.alloc(8192),k=fs.readSync(fd,b);if(!k)break;n+=k;count(k);need(n<=65536);chunks.push(b.subarray(0,k));}result=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch(e){failed=e;}if(fd!==undefined)try{fs.closeSync(fd);}catch{refusal='CLEANUP';throw Object.assign(new Error('OWN_CLEANUP'),{code:'CLEANUP'});}if(failed)throw failed;return result;}
 const credentials=m.statusProjection(ownRead('/proc/self/status'));need(credentials.uid.fourEqual&&credentials.gid.fourEqual&&credentials.uid.allNonzero&&credentials.gid.allNonzero);
 const procfs=m.mountProjection(ownRead('/proc/self/mountinfo'));need(fs.statfsSync('/proc/self',{bigint:true}).type===0x9fa0n);
 const namespaces=['pid','mnt','user'].map(k=>m.namespaceProjection(k,fs.readlinkSync('/proc/self/ns/'+k),fs.readlinkSync('/proc/self/ns/'+k)));
 const image=readFixed('node',134217728),b=binding();need(originals.createHash('sha256').update(image).digest('hex')===b.nodeSha256);
 const os=await import('node:os');
 writeFixed('own-metadata.json',{protocol:'jev-production-owner-own-metadata-v1',platform:'LINUX',architecture:process.arch==='x64'?'X86_64':'ARM64',kernel:m.kernelProjection(os.release()),credentials,procfs,namespaces,node:{version:'22.23.0',napi:10,sha256:b.nodeSha256,bytes:image.length,provenance:'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},priorJobPermissionTransferred:false,continuousCoverage:false,providerAccessQualified:false,recoveryAccepted:false});
}
