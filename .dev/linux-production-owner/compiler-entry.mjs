// Manifest-pinned first entry. The compiler engine/distribution remains trusted.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {fileURLToPath} from 'node:url';
import { install,uninstall,readFixed,jsonFixed,compilerRead,writeFixed,assertPolicy } from './loader.mjs';
install('compiler');
const root=path.dirname(fileURLToPath(import.meta.url));
const catalog=jsonFixed('original-catalog.json');
const mirror=path.join(root,'catalog-metadata');
const rows=new Map(catalog.entries.map(r=>[r[0],r]));
const links=new Map(catalog.links.map(r=>[r[0],r[1]]));
let refused=false,generatedBytes=0,metadataOps=0;
function metadataOp(){if(++metadataOps>1048576)return stop();}
function stop(){refused=true;throw new Error('COMPILER_INPUT_REFUSED');}
function canonical(p){
 if(typeof p!=='string'||p.includes('\0'))return stop();
 let rel=path.relative(root,path.resolve(root,p)).split(path.sep).join('/');
 if(rel==='..'||rel.startsWith('../')||path.isAbsolute(rel))return stop();
 for(let k=0;k<9;k++){
  let changed=false;const parts=rel.split('/');
  for(let n=1;n<=parts.length;n++){const prefix=parts.slice(0,n).join('/');if(links.has(prefix)){rel=path.posix.normalize(links.get(prefix)+(n<parts.length?'/'+parts.slice(n).join('/') : ''));changed=true;break;}}
  if(!changed)return rel;
 }
 return stop();
}
function row(p){const rel=canonical(p);return {rel,value:rows.get(rel)};}
function exists(p,kind){const {value}=row(p);return value!==undefined&&(kind==='directory'?value[1]==='DIRECTORY':value[1]!=='DIRECTORY'&&value[1]!=='LINK');}
function text(p){
 const {rel,value}=row(p);if(!value)return undefined;
 if(value[1]!=='CONTENT')return stop();
 let b;try{b=compilerRead(rel);}catch(e){refused=true;throw e;}
 if(b.length>=2&&b[0]===0xff&&b[1]===0xfe)return b.subarray(2).toString('utf16le');
 if(b.length>=2&&b[0]===0xfe&&b[1]===0xff){if(b.length%2!==0)return stop();return Buffer.from(b.subarray(2)).swap16().toString('utf16le');}
 return b.toString('utf8').replace(/^\uFEFF/,'');
}
function realpath(p){const rel=canonical(p);return path.join(root,rel);}
function catalogueParent(p){const parent=path.posix.dirname(p);return parent==='.'?'':parent;}
function directories(p){
 const rel=canonical(p);if(!exists(p,'directory'))return [];
 return catalog.entries.filter(r=>r[0]&&catalogueParent(r[0])===rel&&exists(path.join(root,r[0]),'directory')).map(r=>path.posix.basename(r[0]));
}
function directoryRead(p,extensions,excludes,includes,depth){
 const rel=canonical(p);if(!exists(p,'directory'))return [];
 // The zero-content mirror contains every bounded original name/type/link,
 // including omitted inputs. It is metadata authority only, never a reader.
 const translate=a=>a?.map(p=>{if(!path.isAbsolute(p))return p;const r=path.relative(root,p);if(r==='..'||r.startsWith('../')||path.isAbsolute(r))return stop();return path.join(mirror,r);});
 return ts.sys.readDirectory(path.join(mirror,rel),extensions,translate(excludes),translate(includes),depth).map(p=>path.join(root,path.relative(mirror,p)));
}
// Public fs adapter is installed before TypeScript creates its sys closure.
// Every mirror directory/type/realpath operation uses only the complete bounded
// source-owned catalog, with no live path traversal, symlink follow or contents.
const originalMetadata={readdirSync:fs.readdirSync,statSync:fs.statSync,realpathSync:fs.realpathSync};
function mirrorRow(p){if(typeof p!=='string')return null;const rel=path.relative(mirror,path.resolve(p));if(rel==='..'||rel.startsWith('../')||path.isAbsolute(rel))return null;metadataOp();return row(path.join(root,rel));}
function missing(){throw Object.assign(new Error('CATALOG_ABSENT'),{code:'ENOENT'});}
fs.readdirSync=function(p,options){const r=mirrorRow(p);if(r===null)return Reflect.apply(originalMetadata.readdirSync,fs,[p,options]);if(!r.value||r.value[1]!=='DIRECTORY')return missing();const out=[];for(const v of catalog.entries){metadataOp();if(v[0]&&catalogueParent(v[0])===r.rel){const name=path.posix.basename(v[0]),kind=v[1];if(options?.withFileTypes)out.push({name,isFile:()=>kind==='CONTENT'||kind==='METADATA_ONLY',isDirectory:()=>kind==='DIRECTORY',isSymbolicLink:()=>kind==='LINK'});else out.push(name);}}return out;};
fs.statSync=function(p,options){const r=mirrorRow(p);if(r===null)return Reflect.apply(originalMetadata.statSync,fs,[p,options]);if(!r.value)return missing();return {isFile:()=>r.value[1]==='CONTENT'||r.value[1]==='METADATA_ONLY',isDirectory:()=>r.value[1]==='DIRECTORY'};};
const mirrorRealpath=function(p,...args){const r=mirrorRow(p);if(r===null)return Reflect.apply(originalMetadata.realpathSync,fs,[p,...args]);if(!r.value)return missing();return path.join(mirror,r.rel);};
mirrorRealpath.native=mirrorRealpath;fs.realpathSync=mirrorRealpath;
process.chdir(root);
const require=createRequire(import.meta.url);
const ts=require('./node_modules/typescript/lib/typescript.js');
if(ts.version!=='5.9.3')stop();
function createDirectory(p){const rel=canonical(p);if(rel!=='dist'&&!rel.startsWith('dist/'))return stop();fs.mkdirSync(path.join(root,rel),{recursive:true,mode:0o700});}
function emitFile(p,data,bom){
 assertPolicy();if(refused)return stop();const rel=canonical(p);
 if(!rel.startsWith('dist/')||typeof data!=='string')return stop();
 const raw=Buffer.from((bom?'\uFEFF':'')+data,'utf8');generatedBytes+=raw.length;
 if(generatedBytes>33554432)return stop();createDirectory(path.dirname(p));
 fs.writeFileSync(path.join(root,rel),raw,{flag:'wx',mode:0o600});
}
const configHost={getCurrentDirectory:()=>root,useCaseSensitiveFileNames:true,readFile:text,fileExists:p=>exists(p,'file'),readDirectory:directoryRead,
 onUnRecoverableConfigFileDiagnostic:d=>{configDiagnostics.push(d);}};
const configDiagnostics=[];
let exit=2;
try{
 const parsed=ts.getParsedCommandLineOfConfigFile(path.join(root,'tsconfig.build.json'),{},configHost);
 assertPolicy();if(refused)stop();
 if(!parsed||configDiagnostics.length||parsed.errors.length){
  const ds=configDiagnostics.concat(parsed?.errors||[]);process.stdout.write(ts.formatDiagnostics(ds,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));exit=1;
 }else{
  const expected=jsonFixed('source-input-contract.json').files.filter(r=>r.relative.endsWith('.ts')).map(r=>r.relative).sort();
  if(JSON.stringify(parsed.fileNames.map(canonical).sort())!==JSON.stringify(expected))stop();
  const host=ts.createCompilerHost(parsed.options);
  Object.assign(host,{readFile:text,fileExists:p=>exists(p,'file'),directoryExists:p=>exists(p,'directory'),
   getDirectories:directories,readDirectory:directoryRead,realpath,getCurrentDirectory:()=>root,
   useCaseSensitiveFileNames:()=>true,getCanonicalFileName:p=>p,
   getDefaultLibLocation:()=>path.join(root,'node_modules/typescript/lib'),
   getDefaultLibFileName:o=>path.join(root,'node_modules/typescript/lib',ts.getDefaultLibFileName(o)),
   getEnvironmentVariable:()=>'',
   writeFile:(p,data,bom,onError)=>{try{emitFile(p,data,bom);}catch(e){refused=true;if(onError)onError(e.message);else throw e;}},createDirectory,trace:s=>process.stdout.write(s+'\n')});
  // Default getSourceFile closes over host.readFile (public TypeScript5.9.3).
  const program=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences,host,configFileParsingDiagnostics:parsed.errors});
  const before=ts.getPreEmitDiagnostics(program);assertPolicy();if(refused)stop();
  const emitted=program.emit();assertPolicy();if(refused)stop();
  const diagnostics=ts.sortAndDeduplicateDiagnostics(before.concat(emitted.diagnostics));
  process.stdout.write(ts.formatDiagnostics(diagnostics,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>root,getNewLine:()=>ts.sys.newLine}));
  exit=diagnostics.length?(emitted.emitSkipped?1:2):0;
  const options=Object.fromEntries(Object.entries(parsed.options).filter(([k])=>k!=='configFile'));
  writeFixed('compiler-result.json',{protocol:'jev-selected-compiler-result-v1',status:exit===0?'COMPILED':'DIAGNOSTICS',policyRefused:false,rootNames:parsed.fileNames.map(canonical),options,generatedBytes});
 }
}finally{assertPolicy();if(refused)exit=2;uninstall();}
process.exitCode=exit;
