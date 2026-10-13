import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import types

CAP=65536
TOTAL_SECONDS=360
CLEANUP_SECONDS=10
SOURCE_LIMIT=1048576
HASH_TOTAL=1024*1024*1024
SLOTS=['node-dependencies','typescript','headers','dependencies','libc-build','libc-abi','addon-build','fixture']
CASE_NAMES=['CURRENT_PRODUCTION_MANAGED_OWNER_SEAM','PRIVATE_AGENT_ENTRY_PARSE_REFUSAL_CLEANUP']
STAGES=['ADMISSION','SOURCE_BINDING','TOOL_BINDING','SOURCE_MATERIALIZATION','NODE_DEPENDENCIES','DEPENDENCY_INVENTORY','TYPESCRIPT','HEADER_DISCOVERY','DEPENDENCY_DISCOVERY','DEPENDENCY_BINDING','LIBC_BUILD','LIBC_ABI','ADDON_BUILD','ARTIFACT_BINDING','ENTRY_BINDING','FIXTURE','RESULT_VALIDATION','SOURCE_RECHECK','RESULT_RETENTION','CLEANUP','UNKNOWN']

def need(v):
    if not v:raise RuntimeError('PRODUCTION_OWNER_REFUSED')
def shape(s):
    return tuple(getattr(s,k) for k in ['st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'])
def sha(v):need(type(v) is str and len(v)==64 and all(c in '0123456789abcdef' for c in v))
def keys(v,w):need(type(v) is dict and set(v)==set(w))
def read(path,cap,deadline,budget):
    need(time.monotonic()<deadline)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and 0<=a.st_size<=cap)
        chunks=[];h=hashlib.sha256();count=0
        while True:
            need(time.monotonic()<deadline);b=os.read(fd,65536)
            if not b:break
            count+=len(b);budget[0]+=len(b);need(count<=cap and budget[0]+budget[1]<=HASH_TOTAL);h.update(b);chunks.append(b)
        need(count==a.st_size and shape(a)==shape(os.fstat(fd))==shape(path.lstat()))
        return b''.join(chunks),{'sha256':h.hexdigest(),'bytes':count},fd,a
    except BaseException:os.close(fd);raise
    # Caller owns the retained FD, including on every post-read failure.
def json_value(raw,cap=CAP,canonical=False):
    need(0<len(raw)<=cap)
    def pairs(rows):
        d={}
        for k,v in rows:need(k not in d);d[k]=v
        return d
    x=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_constant=lambda _:need(False))
    if canonical:need((json.dumps(x,separators=(',',':'),ensure_ascii=False)+'\n').encode()==raw)
    return x
def write(path,raw,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        view=memoryview(raw)
        while view:
            n=os.write(fd,view);need(n>0);view=view[n:]
        os.fsync(fd)
    finally:os.close(fd)
def save(path,value):
    raw=(json.dumps(value,separators=(',',':'))+'\n').encode();need(len(raw)<=CAP);write(path,raw)
def canonical_fixture(raw,code,err):
    need(type(code) is int and code in [0,2] and err==b'');x=json_value(raw,CAP,True)
    keys(x,['protocol','status','stage','code','cases','notification','sample','positive','parse','cleanupKnown','roleTerminalObserved','roleStdio','supervisorProviderEOF','normalRecoveryAccepted'])
    need(x['protocol']=='jev-current-production-owner-fixture-v1' and x['normalRecoveryAccepted'] is False and x['roleStdio']=='IGNORED' and x['supervisorProviderEOF']=='UNPROVED')
    need(type(x['cases']) is list and x['cases']==CASE_NAMES[:len(x['cases'])] and len(x['cases'])<=2)
    need(x['stage'] in ['LOAD','POSITIVE','PRIVATE_PARSE','CLEANUP'] and type(x['cleanupKnown']) is bool and type(x['roleTerminalObserved']) is bool)
    enums=['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP','CLOSED','COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP','PAIR','SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN','FIXTURE','NOT_APPLICABLE']
    need(x['code'] in enums)
    if code==0:
        need(x['status']=='SUPPORTED' and x['cases']==CASE_NAMES and x['cleanupKnown'] is True and x['roleTerminalObserved'] is True and x['code']=='NOT_APPLICABLE')
        note=x['notification'];keys(note,['protocol','sourceOwned','afterManagedReady','workIssued']);need(note=={'protocol':'jev-production-role-notification-v1','sourceOwned':True,'afterManagedReady':True,'workIssued':True})
        sample=x['sample'];keys(sample,['count','twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown'])
        need(type(sample['count']) is int and 2<=sample['count']<128 and all(sample[k] is True for k in sample if k!='count'))
        p=x['positive'];keys(p,['protocol','status','stage','code','fd4Adopted','workComplete','cleanupKnown','settlement','supervisorTerminalEOF','providerTerminalEOF','normalRecoveryAccepted'])
        need(p['protocol']=='jev-production-role-terminal-v1' and p['status']=='SUPPORTED' and p['stage']=='WORK' and p['code']=='NOT_APPLICABLE' and p['fd4Adopted'] is True and p['workComplete'] is True and p['cleanupKnown'] is True and p['normalRecoveryAccepted'] is False and p['supervisorTerminalEOF']=='UNPROVED' and p['providerTerminalEOF']=='UNPROVED')
        keys(p['settlement'],['scope','state','reason']);need(p['settlement']=={'scope':'original-posix-group','state':'empty','reason':'normal-exit:group-absent'})
        q=x['parse'];keys(q,['protocol','returnedCode','fd4Adopted','cleanupKnown','refusal','providerStarted','normalRecoveryAccepted'])
        need(q=={'protocol':'jev-private-entry-parse-result-v1','returnedCode':2,'fd4Adopted':True,'cleanupKnown':True,'refusal':None,'providerStarted':False,'normalRecoveryAccepted':False} and type(q['returnedCode']) is int)
    else:need(x['status']=='REFUSED')
    return x

def main(admission_path):
    os.umask(0o077)
    need(sys.platform=='linux' and all(hasattr(os,k) for k in ['waitid','WNOWAIT','WEXITED','WNOHANG','P_PID']))
    result=None
    root=Path(__file__).resolve().parent;deadline=time.monotonic()+TOTAL_SECONDS;budget=[0,0];held=[];receipts=[];stage='ADMISSION';out=None;active=None;interrupted=[False]
    def interrupt(_s,_f):interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    def input_bytes(path,cap=SOURCE_LIMIT):
        raw,pin,fd,a=read(path,cap,deadline,budget);held.append((fd,path,a));return raw,pin
    def unknown():
        if out:
            try:save(out/'unknown-hold.json',{'protocol':'jev-production-owner-unknown-v1','status':'UNKNOWN_HOLD','stage':stage,'originalSlot':active['slot'] if active else 'UNKNOWN','nativeQualified':False,'recoveryAccepted':False})
            except BaseException:pass
    def close_inputs():
        failed=False
        while held:
            fd,_,_=held.pop()
            try:os.close(fd)
            except BaseException:failed=True
        return not failed
    def hold_without_authority():
        while True:
            unknown()
            try:time.sleep(0.1)
            except BaseException:pass
    try:
        a_raw,_=input_bytes(admission_path);admission=json_value(a_raw)
        keys(admission,['protocol','executionAdmitted','scope','sourceManifestSha256','context','tools','sourceRoot','outputParent','outputName'])
        need(admission['protocol']=='jev-production-owner-qualification-admission-v1' and admission['executionAdmitted'] is True and admission['scope']=='HARMLESS_CURRENT_PRODUCTION_OWNER_ONLY');sha(admission['sourceManifestSha256'])
        ctx=admission['context'];keys(ctx,['repository','head','base','runId','runAttempt','job'])
        need(ctx['repository']=='typicalday/owenloop' and ctx['base']=='b4ead192326ba607558cd3bb7687209cbb7c8165' and ctx['job']=='linux-production-owner-qualification')
        need(type(ctx['head']) is str and len(ctx['head'])==40 and all(c in '0123456789abcdef' for c in ctx['head']))
        for k,cap in [('runId',20),('runAttempt',6)]:need(type(ctx[k]) is str and ctx[k].isascii() and ctx[k].isdigit() and 1<=len(ctx[k])<=cap and not ctx[k].startswith('0'))
        parent=Path(admission['outputParent']);name=admission['outputName']
        need(parent.is_absolute() and parent.is_dir() and not parent.is_symlink())
        need(type(name) is str and name.startswith('jev-production-owner-qualification-') and len(name)<=96 and all(c.isalnum() or c=='-' for c in name))
        out=parent/name;out.mkdir(mode=0o700)
        stage='SOURCE_BINDING';m_raw,m_pin=input_bytes(root/'manifest.json');need(m_pin['sha256']==admission['sourceManifestSha256']);manifest=json_value(m_raw,SOURCE_LIMIT)
        blobs={};source_pins={}
        for r in manifest['executionFiles']:
            need(type(r['relative']) is str and not Path(r['relative']).is_absolute() and '..' not in Path(r['relative']).parts)
            raw,p=input_bytes(root/r['relative']);need(p=={'sha256':r['sha256'],'bytes':r['bytes']});blobs[r['relative']]=raw;source_pins[r['relative']]=p
        required=manifest['executionFiles']
        need(set(blobs)=={r['relative'] for r in required})
        protocol=json_value(blobs['protocol.json'],SOURCE_LIMIT);need(protocol['protocol']=='jev-current-production-owner-qualification-source-v1' and protocol['executionAdmitted'] is False)
        ns={'__name__':'jev_verified_original_custody','__file__':str(root/'dependencies/owner.py')}
        exec(compile(blobs['dependencies/owner.py'],ns['__file__'],'exec'),ns)
        base=types.SimpleNamespace(**ns);base.CLEANUP_SECONDS=CLEANUP_SECONDS
        stage='TOOL_BINDING';keys(admission['tools'],['node','cc','npmCli'])
        tools={};tool_fds={};tool_paths={}
        for label,p in [('node',Path(admission['tools']['node'])),('cc',Path(admission['tools']['cc'])),('python',Path(sys.executable)),('npmCli',Path(admission['tools']['npmCli'])),('selfPs',Path('/bin/ps') if Path('/bin/ps').exists() else Path('/usr/bin/ps'))]:
            need(p.is_absolute());p=p.resolve();raw,pin,fd,z=read(p,512*1024*1024,deadline,budget);held.append((fd,p,z));tool_fds[label]=fd;tool_paths[label]=str(p);tools[label]={**pin,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'}
            if label=='node':
                # A dedicated private executable path for genuine nested cp.spawn.
                project=out/'project';project.mkdir(mode=0o700);node_copy=project/'node';write(node_copy,raw,0o700);node_raw,node_pin=input_bytes(node_copy,512*1024*1024);need(node_pin==pin)
        # Reserve child hashing before any dependency/compiler/fixture original.
        # Six bounded module hooks, one own-node image, three maximum addon reads.
        budget[1]=tools['node']['bytes']+6*33554432+3*8388608
        need(budget[0]+budget[1]<=HASH_TOTAL)
        home=out/'home';home.mkdir(mode=0o700)
        env={'PATH':'/usr/bin:/bin','HOME':str(home),'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC','NODE_OPTIONS':'--max-old-space-size=192'}
        class OwnedChannel(base.PipeChannel):
            def __init__(self,proc,slot,cap):
                super().__init__(proc,out,slot);self.cap=cap;self.overflow=False;self.closed=False;self.terminal_eof=False
            def pump(self,seconds,persist=True):
                need(self.opened)
                for key,_ in self.selector.select(seconds):
                    try:raw=os.read(key.fd,8192)
                    except BlockingIOError:continue
                    if not raw:self.selector.unregister(key.fileobj);continue
                    name=key.data;room=max(0,self.cap-len(self.buffers[name]));self.buffers[name].extend(raw[:room]);self.overflow|=len(raw)>room
                    if persist:
                        fd=self.fds[name];os.lseek(fd,0,0);view=memoryview(self.buffers[name])
                        while view:
                            n=os.write(fd,view);need(n>0);view=view[n:]
                        os.ftruncate(fd,len(self.buffers[name]))
                return self.overflow
            def close(self):
                if self.closed:return
                self.terminal_eof=self.eof();self.closed=True;failed=False
                if self.selector is not None:
                    try:self.selector.close()
                    except BaseException:failed=True
                for stream in [self.proc.stdout,self.proc.stderr]:
                    try:stream.close()
                    except BaseException:failed=True
                for fd in self.fds.values():
                    try:os.close(fd)
                    except BaseException:failed=True
                need(not failed)
        def original(label,argv,seconds,cap=CAP,child_env=None,extra_fds=(),tool=None,execfd=None):
            nonlocal active,stage
            need(label in SLOTS and all(r['slot']!=label for r in receipts) and not interrupted[0] and time.monotonic()<deadline)
            c=None;channel=None
            imagefd=tool_fds[tool] if tool else execfd
            need(imagefd is not None)
            proc=subprocess.Popen(argv,executable='/proc/self/fd/'+str(imagefd),cwd=out,env=child_env or env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True,pass_fds=tuple(set(extra_fds+(imagefd,))))
            active={'proc':proc,'slot':label,'custody':None,'channel':None}
            try:
                c=base.OriginalCustody(proc);active['custody']=c;channel=OwnedChannel(proc,label,cap);active['channel']=channel
                try:
                    if label!='fixture':raw,err,code=base.drive_original(c,channel,min(deadline,time.monotonic()+seconds),interrupted,unknown)
                    else:
                        channel.open();fixture_deadline=min(deadline,time.monotonic()+seconds);failed=False
                        try:
                            while True:
                                need(not interrupted[0] and time.monotonic()<fixture_deadline)
                                state=c.observe();need(state!='UNKNOWN');need(not channel.pump(0.02))
                                if state=='TERMINAL_UNREAPED' and channel.eof():break
                            code=c.finalize(True)
                        except BaseException:
                            failed=True;cleanup_end=time.monotonic()+CLEANUP_SECONDS
                            state=c.observe()
                            if not c.reap_attempted and not c.uncertain and state=='LIVE':
                                try:c.send(signal.SIGTERM)
                                except BaseException:pass
                            while not c.reaped:
                                if time.monotonic()>=cleanup_end:unknown()
                                state=c.observe()
                                try:channel.pump(0.02,False)
                                except BaseException:c.uncertain=True
                                if state=='TERMINAL_UNREAPED' and channel.eof():
                                    try:code=c.finalize(True)
                                    except BaseException:pass
                                if not c.reaped:
                                    try:time.sleep(0.1)
                                    except BaseException:pass
                        raw,err=channel.output();need(not failed)
                finally:
                    if not c.reaped:hold_without_authority()
                    stdout,stderr=channel.output();eof=channel.eof()
                    receipts.append({'slot':label,'directOriginalTerminal':True,'directOriginalReaped':True,'ownedPipesEOF':eof,'exitCode':proc.returncode,'signalsSent':c.signals,'stdoutBytes':len(stdout),'stdoutSha256':hashlib.sha256(stdout).hexdigest(),'stderrBytes':len(stderr),'stderrSha256':hashlib.sha256(stderr).hexdigest(),'streamTruncated':channel.overflow,'globalGroupAbsenceClaimed':False})
                    try:channel.close()
                    finally:active=None
                need(c.reaped and channel.terminal_eof and not channel.overflow and not interrupted[0] and time.monotonic()<deadline)
                return raw,err,code
            except BaseException:
                if active:
                    if c is None or channel is None:hold_without_authority()
                    if not c.reaped:hold_without_authority()
                    active=None
                raise
        def good(x):
            raw,err,code=x;need(code==0 and err==b'');return raw
        stage='SOURCE_MATERIALIZATION'
        inventory=json_value(blobs['source-inventory.json'],SOURCE_LIMIT)
        need(inventory['engineHead']=='8892b0aa4e3d00b750b330bc4e534553cba59d4d' and inventory['engineTree']=='8d996573b5f646db6c038950943054a8521631ac')
        source_root=Path(admission['sourceRoot']);need(source_root.is_absolute() and source_root.is_dir() and not source_root.is_symlink())
        source_observations=[]
        for row in inventory['files']:
            rel=row['relative'];need(type(rel) is str and not Path(rel).is_absolute() and '..' not in Path(rel).parts)
            raw,p=input_bytes(source_root/rel,8388608);expected=source_pins['overlay/'+rel] if rel=='packages/work/src/harness/routed-owner-observer.ts' else {k:row[k] for k in ['sha256','bytes']};need(p==expected)
            dest=project/rel;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);write(dest,raw)
            source_observations.append({'relative':rel,**p})
        overlay='packages/work/src/harness/routed-owner-observer.ts';(project/overlay).unlink();write(project/overlay,blobs['overlay/'+overlay])
        for n in ['loader.mjs','fixture.mjs','provider.mjs']:write(project/n,blobs[n])
        write(project/'metadata.mjs',blobs['dependencies/metadata.mjs'])
        write(project/'compiler-entry.mjs',b"import { install } from './loader.mjs'; install();\n")
        (project/'entry-results').mkdir(mode=0o700);(project/'gates').mkdir(mode=0o700)
        stage='NODE_DEPENDENCIES'
        # npm/runtime distribution is explicit platform trust; ignore every project install script.
        user_config=out/'npm-user.config';global_config=out/'npm-global.config'
        write(user_config,b'');write(global_config,b'')
        npm_env={**env,'NODE_OPTIONS':'--max-old-space-size=256','NPM_CONFIG_USERCONFIG':str(user_config),'NPM_CONFIG_GLOBALCONFIG':str(global_config),'NPM_CONFIG_CACHE':str(out/'npm-cache')}
        nr,ne,nc=original('node-dependencies',[tool_paths['node'],tool_paths['npmCli'],'--prefix',str(project),'ci','--ignore-scripts','--no-audit','--no-fund'],90,child_env=npm_env,tool='node')
        need(nc==0)
        stage='DEPENDENCY_INVENTORY'
        module_rows=[];dependency_rows=[];dependency_stats=[];module_paths=set()
        for path in sorted((project/'node_modules').rglob('*')):
            if path.is_symlink():
                resolved=path.resolve();need(resolved.is_relative_to(project));continue
            if not path.is_file():continue
            need(len(dependency_rows)<16384)
            raw,pin,dfd,z=read(path,512*1024*1024,deadline,budget)
            try:need(shape(z)==shape(path.lstat()))
            finally:os.close(dfd)
            rel=str(path.relative_to(project));dependency_rows.append({'relative':rel,**pin});dependency_stats.append((path,z))
        def runtime_closure():
            result=[];seen=set();package_types={};installed={r['relative']:r for r in dependency_rows}
            for p in sorted(project.rglob('*')):
                if p.is_symlink():need(p.resolve().is_relative_to(project));continue
                if not p.is_file() or (p.suffix not in ['.js','.mjs','.cjs','.json'] and str(p.relative_to(project))!='node_modules/typescript/bin/tsc'):continue
                rel=str(p.relative_to(project))
                if rel in ['runtime-closure.json','binding.json'] or rel.startswith(('entry-results/','gates/')):continue
                need(len(result)<16384 and rel not in seen);seen.add(rel)
                if rel in installed:pin={k:installed[rel][k] for k in ['sha256','bytes']}
                else:
                    raw,pin,dfd,z=read(p,16777216,deadline,budget)
                    try:need(shape(z)==shape(p.lstat()))
                    finally:os.close(dfd)
                form='json' if p.suffix=='.json' else 'module' if p.suffix=='.mjs' else 'commonjs'
                if p.suffix=='.js':
                    parent=p.parent
                    while parent.is_relative_to(project):
                        pkg=parent/'package.json'
                        if pkg.is_file():
                            # Every such manifest is included and same-byte loaded by the hook.
                            if pkg not in package_types:
                                pr,_,pfd,_=read(pkg,SOURCE_LIMIT,deadline,budget)
                                try:package_types[pkg]=json_value(pr,SOURCE_LIMIT).get('type')
                                finally:os.close(pfd)
                            if package_types[pkg]=='module':form='module'
                            break
                        if parent==project:break
                        parent=parent.parent
                result.append({'relative':rel,**pin,'format':form})
            raw=(json.dumps({'protocol':'jev-production-runtime-closure-v1','files':result},separators=(',',':'))+'\n').encode();need(len(raw)<=SOURCE_LIMIT)
            p=project/'runtime-closure.json'
            if p.exists():p.unlink()
            write(p,raw);return result,{'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
        runtime_closure()
        stage='TYPESCRIPT'
        good(original('typescript',[str(node_copy),'--import',str(project/'compiler-entry.mjs'),str(project/'node_modules/typescript/bin/tsc'),'-p',str(project/'tsconfig.build.json')],60,tool='node',child_env={**env,'NODE_OPTIONS':'--max-old-space-size=512'}))
        stage='HEADER_DISCOVERY';headers=out/'headers';headers.mkdir(mode=0o700)
        # Execute the same verified header helper bytes through a retained FD.
        hf=out/'headers.py';write(hf,blobs['headers.py']);_,_,hfd,z=read(hf,SOURCE_LIMIT,deadline,budget);held.append((hfd,hf,z))
        header_result=json_value(good(original('headers',[tool_paths['python'],'-B','-I','-S','/proc/self/fd/'+str(hfd),str(headers)],25,extra_fds=(hfd,),tool='python')),canonical=True)
        need(header_result['protocol']=='jev-owned-pair-headers-v1' and header_result['archiveSha256']==protocol['headerArchiveSha256'])
        need(set(header_result['selected'])=={'node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'})
        for n,p in header_result['selected'].items():_,actual=input_bytes(headers/n);need(actual==p)
        stage='DEPENDENCY_DISCOVERY';build=out/'build';build.mkdir(mode=0o700)
        direct=build/'direct';direct.mkdir(mode=0o700)
        direct_source=direct/'descriptor.c';write(direct_source,blobs['inputs/direct/descriptor.c']);_,direct_pin=input_bytes(direct_source);need(direct_pin==source_pins['inputs/direct/descriptor.c'])
        source=build/'relay.c';write(source,blobs['inputs/relay.c']);_,source_pin,sfd,z=read(source,SOURCE_LIMIT,deadline,budget);held.append((sfd,source,z));need(source_pin==source_pins['inputs/relay.c'])
        flags=['-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-DNAPI_VERSION=8','-DNODE_GYP_MODULE_NAME=jev_one_relay','-I',str(headers),'-I',str(build)]
        source_arg='/proc/self/fd/'+str(sfd)
        libc_source=build/'libc-contract.c';write(libc_source,blobs['libc-contract.c']);_,_,lfd,z=read(libc_source,SOURCE_LIMIT,deadline,budget);held.append((lfd,libc_source,z));libc_exe=build/'libc-contract';libc_arg='/proc/self/fd/'+str(lfd)
        raw=good(original('dependencies',[tool_paths['cc'],*flags,'-x','c','-M','-MT','JEV_ONE_RELAY',source_arg,libc_arg],15,cap=131072,extra_fds=(sfd,lfd),tool='cc'))
        text=raw.decode('ascii').replace('\\\n',' ');parts=text.split('JEV_ONE_RELAY:');need(len(parts)==3 and parts[0]=='');tokens=' '.join(parts[1:]).split();need(1<=len(tokens)<=512)
        dependency_paths=[];dependencies=[]
        stage='DEPENDENCY_BINDING'
        for token in tokens:
            need(token.startswith('/') and all(c.isalnum() or c in '/_.+-' for c in token));p=source if token==source_arg else (libc_source if token==libc_arg else Path(token).resolve())
            if p in dependency_paths:continue
            need(p.is_absolute());raw,pin=input_bytes(p,512*1024*1024);dependency_paths.append(p);dependencies.append({'pathSha256':hashlib.sha256(str(p).encode()).hexdigest(),**pin})
        need(source in dependency_paths and direct_source in dependency_paths and libc_source in dependency_paths and all((headers/n).resolve() in dependency_paths for n in header_result['selected']))
        stage='LIBC_BUILD'
        good(original('libc-build',[tool_paths['cc'],*flags,'-x','c',libc_arg,'-o',str(libc_exe)],20,extra_fds=(lfd,),tool='cc'))
        libc_bytes,libc_pin,libcfd,z=read(libc_exe,8388608,deadline,budget);held.append((libcfd,libc_exe,z))
        stage='LIBC_ABI';need(good(original('libc-abi',[str(libc_exe)],5,execfd=libcfd))==b'JEV_PUBLIC_GLIBC_PIDFD_ABI_V1\n')
        stage='ADDON_BUILD';artifact=build/'relay.node'
        good(original('addon-build',[tool_paths['cc'],*flags,'-shared','-x','c',source_arg,'-o',str(artifact)],25,extra_fds=(sfd,),tool='cc'))
        stage='ARTIFACT_BINDING';artifact_bytes,artifact_pin=input_bytes(artifact,8388608)
        for p,expected in zip(dependency_paths,dependencies):
            _,current=input_bytes(p,512*1024*1024);need(current=={k:expected[k] for k in ['sha256','bytes']})
        stage='ENTRY_BINDING'
        # Fixed adjacent declarations are measured only after actual builds.
        composition=json_value(blobs['source-composition.json'],SOURCE_LIMIT)
        binding={'protocol':'jev-production-binding-v1','enabled':True,'artifact':str(artifact),'artifactSha256':artifact_pin['sha256'],'roleEntry':str(project/'bin/harmless-role.mjs'),'privateEntry':str(project/'bin/private-entry.mjs'),'provider':str(project/'provider.mjs'),'gateDirectory':str(project/'gates'),'nodeSha256':tools['node']['sha256'],'fixtureDeadlineUnixMs':int(time.time()*1000)+40000}
        write(project/'binding.json',(json.dumps(binding,separators=(',',':'))+'\n').encode());_,binding_pin=input_bytes(project/'binding.json')
        write(project/'bin/harmless-role.mjs',blobs['role.mjs']);write(project/'bin/private-entry.mjs',blobs['private-entry.mjs'])
        emitted,emitted_pin=runtime_closure()
        declaration={'protocol':'private-routed-role-observer-build-v2','enabled':True,'artifact':str(artifact),'artifactSha256':artifact_pin['sha256'],'sourceCompositionSha256':source_pins['source-composition.json']['sha256'],'compiledSourceManifestSha256':emitted_pin['sha256']}
        write(project/'bin/private-role-observer-build.mjs',('export const ROLE_OBSERVER_BUILD = Object.freeze('+json.dumps(declaration,separators=(',',':'))+');\n').encode())
        runtime_rows,final_runtime_pin=runtime_closure();_,actual_runtime_pin=input_bytes(project/'runtime-closure.json');need(actual_runtime_pin==final_runtime_pin);_,declaration_pin=input_bytes(project/'bin/private-role-observer-build.mjs')
        # Five fixture Node entries plus one compiler hook; at most four fixture Nodes concurrent. Nested native
        # source is the exact embedded current production string, not a facade.
        child_hash_bound=tools['node']['bytes']+6*33554432+3*artifact_pin['bytes']
        budget[1]=child_hash_bound
        need(budget[0]+budget[1]<=HASH_TOTAL)
        stage='FIXTURE'
        raw,err,code=original('fixture',[str(node_copy),str(project/'fixture.mjs')],40,cap=CAP,child_env=env,execfd=next(fd for fd,p,_ in held if p==node_copy))
        stage='RESULT_VALIDATION';result=canonical_fixture(raw,code,err)
        own_raw,own_pin=input_bytes(project/'own-metadata.json');own=json_value(own_raw,canonical=True)
        keys(own,['protocol','platform','architecture','kernel','credentials','procfs','namespaces','node','priorJobPermissionTransferred','continuousCoverage','providerAccessQualified','recoveryAccepted'])
        need(own['platform']=='LINUX' and own['architecture'] in ['X86_64','ARM64'] and own['priorJobPermissionTransferred'] is False and own['continuousCoverage'] is False)
        need(own['protocol']=='jev-production-owner-own-metadata-v1' and own['node']['sha256']==tools['node']['sha256'] and own['node']['version']=='22.23.0' and own['providerAccessQualified'] is False and own['recoveryAccepted'] is False)
        stage='SOURCE_RECHECK'
        for name,before in blobs.items():raw,after=input_bytes(root/name);need(after==source_pins[name] and raw==before)
        for fd,p,z in held:need(shape(z)==shape(os.fstat(fd))==shape(p.lstat()))
        for rel,expected in [('binding.json',binding_pin),('runtime-closure.json',final_runtime_pin),('bin/private-role-observer-build.mjs',declaration_pin)]:
            _,after=input_bytes(project/rel,SOURCE_LIMIT);need(after==expected)
        for row in runtime_rows:
            if row['relative'] not in {d['relative'] for d in dependency_rows}:
                _,after=input_bytes(project/row['relative'],16777216);need(after=={k:row[k] for k in ['sha256','bytes']})
        # Per-file stat closure, not a compiler-distribution execution-byte claim.
        # Runtime imports separately hash and execute the same read bytes.
        for p,z in dependency_stats:need(shape(z)==shape(p.lstat()))
        need(not interrupted[0] and time.monotonic()<deadline and budget[0]+child_hash_bound<=HASH_TOTAL and [r['slot'] for r in receipts]==SLOTS and all(r['directOriginalTerminal'] is True and r['directOriginalReaped'] is True and r['exitCode']==0 and r['signalsSent']==0 and not r['streamTruncated'] and r['ownedPipesEOF'] is True for r in receipts))
        stage='CLEANUP';need(close_inputs())
        stage='RESULT_RETENTION'
        summary={'protocol':'jev-production-owner-qualification-result-v1','status':'SUPPORTED' if code==0 else 'UNSUPPORTED','stage':stage,'fixture':result,'originals':receipts,'sourceManifestSha256':m_pin['sha256'],'sourcePins':source_pins,'context':ctx,'tools':tools,'headers':header_result,'selectedDependencyCount':len(dependencies),'selectedDependenciesSha256':hashlib.sha256(json.dumps(dependencies,separators=(',',':')).encode()).hexdigest(),'artifact':artifact_pin,'libcContract':libc_pin,'ownMetadata':own,'ownMetadataPin':own_pin,'hashBudget':{'ownerSelectedBytes':budget[0],'fixtureAdditionalBoundBytes':child_hash_bound,'nodeInitializers':5,'compilerHookInitializers':1,'maximumConcurrentNodeProcesses':4,'addonHashPasses':3,'perInitializerLoadedModuleCapBytes':33554432,'totalCapBytes':HASH_TOTAL},'currentSourceComposition':source_pins['source-composition.json'],'trackedCompileInputCount':len(source_observations),'dependencyInventorySha256':hashlib.sha256(json.dumps(dependency_rows,separators=(',',':')).encode()).hexdigest(),'emittedBeforeDeclaration':emitted_pin,'runtimeModuleClosure':final_runtime_pin,'privateBinding':binding_pin,'privateBuildDeclaration':declaration_pin,'ordinaryCompilationCompleted':True,'inputFDsClosed':True,'deadlineReached':False,'interrupted':False,'platformRuntimeTrustRequired':True,'compilerDistributionQualified':False,'globalGroupAbsenceClaimed':False,'providerAccessQualified':False,'recoveryAccepted':False}
        # Private raw streams and dependency paths never enter the result.
        save(out/'dependency-closure.private.json',{'paths':[str(p) for p in dependency_paths],'pins':dependencies})
        save(out/'result.json',summary)
        need(not interrupted[0] and time.monotonic()<deadline)
        print('JEV_PRODUCTION_OWNER_COMPLETE' if code==0 else 'JEV_PRODUCTION_OWNER_UNSUPPORTED');return code
    except BaseException:
        if active:hold_without_authority()
        if not close_inputs():stage='CLEANUP'
        if out:
            try:save(out/'result.json',{'protocol':'jev-production-owner-qualification-result-v1','status':'REFUSED','stage':stage if stage in STAGES else 'UNKNOWN','originals':receipts,'deadlineReached':time.monotonic()>=deadline,'interrupted':interrupted[0],'nativeQualified':False,'providerAccessQualified':False,'recoveryAccepted':False,'globalGroupAbsenceClaimed':False,'fixtureDiagnostic':None if result is None else {k:result[k] for k in ['status','stage','code','cleanupKnown','roleTerminalObserved']}})
            except BaseException:pass
        print('JEV_PRODUCTION_OWNER_REFUSED',file=sys.stderr);return 2
    finally:
        if not close_inputs():raise RuntimeError('PRODUCTION_OWNER_REFUSED')
