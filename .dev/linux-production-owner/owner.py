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
CLOSE_UNCERTAIN=False
UNCERTAIN_CLOSE_RECORDS=[None]*8192
UNCERTAIN_CLOSE_COUNT=0
def checked_close(fd):
    global CLOSE_UNCERTAIN,UNCERTAIN_CLOSE_COUNT
    try:os.close(fd)
    except BaseException:
        CLOSE_UNCERTAIN=True
        # Fixed preallocated retention; never retry a failed numeric close.
        if UNCERTAIN_CLOSE_COUNT<len(UNCERTAIN_CLOSE_RECORDS):
            UNCERTAIN_CLOSE_RECORDS[UNCERTAIN_CLOSE_COUNT]=fd;UNCERTAIN_CLOSE_COUNT+=1
        raise

def shape(s):
    return tuple(getattr(s,k) for k in ['st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'])
def sha(v):need(type(v) is str and len(v)==64 and all(c in '0123456789abcdef' for c in v))
def keys(v,w):need(type(v) is dict and set(v)==set(w))
def read(path,cap,deadline,budget):
    need(time.monotonic()<deadline)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        a=os.fstat(fd)
        need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and 0<=a.st_size<=cap)
        chunks=[];h=hashlib.sha256();count=0
        while True:
            need(time.monotonic()<deadline)
            b=os.read(fd,65536)
            if not b:break
            count+=len(b);budget[0]+=len(b)
            need(count<=cap and budget[0]+budget[1]<=HASH_TOTAL)
            h.update(b);chunks.append(b)
        need(count==a.st_size and shape(a)==shape(os.fstat(fd))==shape(path.lstat()))
        return b''.join(chunks),{'sha256':h.hexdigest(),'bytes':count},fd,a
    except BaseException as error:
        checked_close(fd)
        raise
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
    finally:checked_close(fd)
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

# Passive post-selection companion. No extra reads, hash authority or acceptance.
CATALOG_PHASES=('SELECTED_RETURN','PROJECT_STORAGE_BASE','PROJECT_ROWS','PROJECT_STORAGE_EXTEND','CATALOG_ENTRY_CAP','CATALOG_PROJECTION','CATALOG_SERIALIZE','CATALOG_INPUT_CAP','CATALOG_WRITE','UNKNOWN')
CATALOG_COUNTERS=('selectionEntries','selectedRows','selectionLogicalStorage','projectLogicalStorage','extraFiles','extraDirs','catalogEntries','catalogBytes')
def catalog_state():
    try:return {'phase':'UNKNOWN','counters':dict.fromkeys(CATALOG_COUNTERS),'saturated':False,'unknown':False}
    except BaseException:return None
def catalog_note(state,phase,selection=None,logical_storage=None,extra_files=None,extra_dirs=None,catalog_entries=None,catalog_raw=None):
    try:
        if type(state) is not dict:return
        state['phase']=phase if phase in CATALOG_PHASES else 'UNKNOWN'
        values={}
        if type(selection) is dict:
            values['selectionEntries']=len(selection['entries'])
            values['selectedRows']=len(selection['selected'])
            values['selectionLogicalStorage']=selection['logicalStorageBytes']
        if logical_storage is not None:values['projectLogicalStorage']=logical_storage
        if extra_files is not None:values['extraFiles']=len(extra_files)
        if extra_dirs is not None:values['extraDirs']=len(extra_dirs)
        if catalog_entries is not None:values['catalogEntries']=len(catalog_entries)
        if catalog_raw is not None:values['catalogBytes']=len(catalog_raw)
        for name,value in values.items():
            if type(value) is int and value>=0:
                state['counters'][name]=min(value,2147483647)
                if value>2147483647:state['saturated']=True
            else:state['counters'][name]=None;state['unknown']=True
    except BaseException:
        try:state['unknown']=True
        except BaseException:pass
def catalog_snapshot(state,error,stage):
    try:
        if type(state) is not dict or stage!='DEPENDENCY_INVENTORY':return None
        code='OTHER'
        if type(error) is RuntimeError and BaseException.args.__get__(error)==('PRODUCTION_OWNER_REFUSED',):code='PREDICATE_REFUSED'
        elif type(error) is MemoryError:code='ALLOCATION'
        elif state['phase']=='CATALOG_SERIALIZE' and type(error) in (TypeError,ValueError,OverflowError):code='SERIALIZATION'
        value={'protocol':'jev-post-selected-catalog-diagnostic-v1','phase':state['phase'],'error':code,'counters':state['counters'].copy(),'saturated':state['saturated'],'unknown':state['unknown']}
        raw=(json.dumps(value,separators=(',',':'))+'\n').encode('ascii')
        if len(raw)<=1024:return value
    except BaseException:pass
    return None

def main(admission_path):
    os.umask(0o077)
    need(sys.platform=='linux' and all(hasattr(os,k) for k in ['waitid','WNOWAIT','WEXITED','WNOHANG','P_PID']))
    result=None;selection_custody={'cleanupKnown':True};selection=None;meter=None
    post_catalog=None
    root=Path(__file__).resolve().parent;deadline=time.monotonic()+TOTAL_SECONDS;budget=[0,0];held=[];receipts=[];stage='ADMISSION';out=None;active=None;interrupted=[False]
    def interrupt(_s,_f):interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    def input_bytes(path,cap=SOURCE_LIMIT):
        need(len(held)<4096)
        raw,pin,fd,a=read(path,cap,deadline,budget)
        try:held.append((fd,path,a))
        except BaseException:
            checked_close(fd);raise
        return raw,pin
    def input_fd(path,cap=SOURCE_LIMIT):
        raw,pin=input_bytes(path,cap);fd,_,z=held[-1];return raw,pin,fd,z
    def unknown():
        if out:
            try:save(out/'unknown-hold.json',{'protocol':'jev-production-owner-unknown-v1','status':'UNKNOWN_HOLD','stage':stage,'originalSlot':active['slot'] if active else 'UNKNOWN','nativeQualified':False,'recoveryAccepted':False})
            except BaseException:pass
    def close_inputs():
        failed=False
        while held:
            fd,_,_=held.pop()
            try:checked_close(fd)
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
        selected_ns={'__name__':'jev_verified_selected_inputs'}
        exec(compile(blobs['selected-inputs.py'],str(root/'selected-inputs.py'),'exec'),selected_ns)
        meter=selected_ns['IntegrityMeter']();meter.charge('initial',budget[0]);budget=meter
        def integrity_digest(raw):
            meter.charge('metadata',len(raw));return hashlib.sha256(raw).hexdigest()
        ns={'__name__':'jev_verified_original_custody','__file__':str(root/'dependencies/owner.py')}
        exec(compile(blobs['dependencies/owner.py'],ns['__file__'],'exec'),ns)
        base=types.SimpleNamespace(**ns);base.CLEANUP_SECONDS=CLEANUP_SECONDS
        stage='TOOL_BINDING';keys(admission['tools'],['node','cc','npmCli'])
        tools={};tool_fds={};tool_paths={}
        for label,p in [('node',Path(admission['tools']['node'])),('cc',Path(admission['tools']['cc'])),('python',Path(sys.executable)),('npmCli',Path(admission['tools']['npmCli'])),('selfPs',Path('/bin/ps') if Path('/bin/ps').exists() else Path('/usr/bin/ps'))]:
            need(p.is_absolute());p=p.resolve();raw,pin,fd,z=input_fd(p,134217728 if label=='node' else 33554432);tool_fds[label]=fd;tool_paths[label]=str(p);tools[label]={**pin,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'}
            if label=='node':
                # A dedicated private executable path for genuine nested cp.spawn.
                project=out/'project';project.mkdir(mode=0o700);node_copy=project/'node';write(node_copy,raw,0o700);node_raw,node_pin=input_bytes(node_copy,134217728);need(node_pin==pin)
        # Every future child allowance is reserved by the partition meter.
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
                    try:checked_close(fd)
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
                    receipts.append({'slot':label,'directOriginalTerminal':True,'directOriginalReaped':True,'ownedPipesEOF':eof,'exitCode':proc.returncode,'signalsSent':c.signals,'stdoutBytes':len(stdout),'stdoutSha256':integrity_digest(stdout),'stderrBytes':len(stderr),'stderrSha256':integrity_digest(stderr),'streamTruncated':channel.overflow,'globalGroupAbsenceClaimed':False})
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
        for n in ['loader.mjs','fixture.mjs','provider.mjs','compiler-entry.mjs','initializer.mjs']:write(project/n,blobs[n])
        write(project/'metadata.mjs',blobs['dependencies/metadata.mjs'])
        (project/'entry-results').mkdir(mode=0o700);(project/'gates').mkdir(mode=0o700)
        (project/'integrity-results').mkdir(mode=0o700);(project/'warnings').mkdir(mode=0o700)
        for name in ['fixture','positiveRole','parserRole','supervisor','provider']:write(project/'warnings'/(name+'.txt'),b'')
        installation=out/'installation';installation.mkdir(mode=0o700)
        for rel in ['package.json','package-lock.json','packages/work/package.json']:
            q=installation/rel;q.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            raw,_=input_bytes(project/rel);write(q,raw)
        stage='NODE_DEPENDENCIES'
        # npm/runtime distribution is explicit platform trust; ignore every project install script.
        user_config=out/'npm-user.config';global_config=out/'npm-global.config'
        write(user_config,b'');write(global_config,b'')
        npm_env={**env,'NODE_OPTIONS':'--max-old-space-size=256','NPM_CONFIG_USERCONFIG':str(user_config),'NPM_CONFIG_GLOBALCONFIG':str(global_config),'NPM_CONFIG_CACHE':str(out/'npm-cache')}
        nr,ne,nc=original('node-dependencies',[tool_paths['node'],tool_paths['npmCli'],'--prefix',str(installation),'ci','--ignore-scripts','--no-audit','--no-fund'],90,child_env=npm_env,tool='node')
        need(nc==0)
        stage='DEPENDENCY_INVENTORY'
        # Explicit changed authority: catalog the full installation metadata,
        # copy only declared candidates, and refuse every omitted content request.
        selection=selected_ns['selected_installed'](installation,project,deadline,interrupted,read,write,meter,selection_custody)
        post_catalog=catalog_state()
        catalog_note(post_catalog,'SELECTED_RETURN',selection=selection)
        if selection_custody['cleanupKnown'] is not True:hold_without_authority()
        dependency_rows=selection['selected'];dependency_stats=[]
        catalog_entries=selection['entries']
        logical_storage=selection['logicalStorageBytes']+1048576
        catalog_note(post_catalog,'PROJECT_STORAGE_BASE',logical_storage=logical_storage)
        need(logical_storage<=8388608)
        # This finite map is declared from already-read source bytes, not a
        # second filesystem iterator or guessed absence projection.
        extra_files={r['relative']:r['bytes'] for r in source_observations}
        for n in ['loader.mjs','fixture.mjs','provider.mjs','compiler-entry.mjs','initializer.mjs']:
            extra_files[n]=len(blobs[n])
        extra_files['metadata.mjs']=len(blobs['dependencies/metadata.mjs']);extra_files['node']=tools['node']['bytes']
        for n in ['fixture','positiveRole','parserRole','supervisor','provider']:extra_files['warnings/'+n+'.txt']=0
        extra_dirs={'entry-results','gates','integrity-results','warnings'}
        for rel in extra_files:
            parts=Path(rel).parts
            for n in range(1,len(parts)):extra_dirs.add('/'.join(parts[:n]))
        catalog_note(post_catalog,'PROJECT_ROWS',extra_files=extra_files,extra_dirs=extra_dirs)
        need(len(extra_files)+len(extra_dirs)<=4096)
        for rel in sorted(extra_dirs):
            logical_storage+=192+4*len(os.fsencode(rel))
            catalog_note(post_catalog,'PROJECT_STORAGE_EXTEND',logical_storage=logical_storage)
            need(logical_storage<=8388608)
            catalog_entries.append([rel,'DIRECTORY',0])
        for rel,size in sorted(extra_files.items()):
            logical_storage+=192+4*len(os.fsencode(rel))
            catalog_note(post_catalog,'PROJECT_STORAGE_EXTEND',logical_storage=logical_storage)
            need(logical_storage<=8388608)
            catalog_entries.append([rel,'CONTENT',size])
        catalog_entries.append(['','DIRECTORY',0])
        catalog_note(post_catalog,'CATALOG_ENTRY_CAP',catalog_entries=catalog_entries)
        need(len(catalog_entries)<=32768)
        catalog_note(post_catalog,'CATALOG_PROJECTION')
        catalog={'protocol':'jev-selected-compiler-catalog-v2','entries':catalog_entries,'links':selection['links'],'selectedCount':len(dependency_rows),'metadataOps':selection['metadataOps'],'logicalStorageBytes':logical_storage,'selectedBytes':selection['selectedBytes'],'snapshotOnly':selection['snapshotOnly']}
        meter.kind='metadata'
        catalog_note(post_catalog,'CATALOG_SERIALIZE')
        catalog_raw=(json.dumps(catalog,separators=(',',':'))+'\n').encode()
        catalog_note(post_catalog,'CATALOG_INPUT_CAP',catalog_raw=catalog_raw)
        need(len(catalog_raw)<=SOURCE_LIMIT)
        catalog_note(post_catalog,'CATALOG_WRITE')
        integrity_digest(catalog_raw);write(project/'original-catalog.json',catalog_raw)
        post_catalog=None
        write(project/'source-input-contract.json',blobs['source-inventory.json'])
        # Public TypeScript sys reads a catalog-backed virtual metadata mirror.
        # No live mirror directory traversal or zero-content files are used.
        (project/'catalog-metadata').mkdir(mode=0o700)
        meter.kind='late'
        def runtime_closure():
            result=[];installed={v['relative']:v for v in dependency_rows}
            for q in sorted(project.rglob('*')):
                rel=str(q.relative_to(project))
                if rel.startswith(('catalog-metadata/','entry-results/','gates/','integrity-results/','warnings/')) or rel in ['node','runtime-closure.json','binding.json','original-catalog.json','compiler-result.json']:continue
                if q.is_symlink():need(q.resolve().is_relative_to(project));continue
                if not q.is_file():continue
                need(len(result)<16384)
                if rel in installed:pin={k:installed[rel][k] for k in ['sha256','bytes']}
                else:_,pin=input_bytes(q,16777216)
                form='json' if q.suffix=='.json' else 'module' if q.suffix=='.mjs' else 'commonjs' if q.suffix in ['.js','.cjs'] else 'resource'
                if q.suffix=='.js':
                    parent=q.parent
                    while parent.is_relative_to(project):
                        pkg=parent/'package.json'
                        if pkg.is_file():
                            pr,_=input_bytes(pkg);form='module' if json_value(pr,SOURCE_LIMIT).get('type')=='module' else 'commonjs';break
                        if parent==project:break
                        parent=parent.parent
                result.append({'relative':rel,**pin,'format':form})
            raw=(json.dumps({'protocol':'jev-production-runtime-closure-v1','files':result},separators=(',',':'))+'\n').encode();need(len(raw)<=SOURCE_LIMIT)
            p=project/'runtime-closure.json'
            if p.exists():p.unlink()
            write(p,raw);return result,{'sha256':integrity_digest(raw),'bytes':len(raw)}
        write(project/'binding.json',(json.dumps({'protocol':'jev-production-binding-v1','enabled':False,'artifact':None},separators=(',',':'))+'\n').encode())
        (project/'dist').mkdir(mode=0o700)
        runtime_closure()
        def node_flags(profile,heap=192):
            v=['--max-old-space-size='+str(heap),'--permission','--allow-fs-read='+str(project)]
            writable=['dist','compiler-result.json','integrity-results'] if profile=='compiler' else ['entry-results','gates','integrity-results','warnings','own-metadata.json']
            v+=['--allow-fs-write='+str(project/p) for p in writable]
            if profile!='compiler':v+=['--allow-fs-read=/proc/self','--allow-fs-read=/bin/ps','--allow-fs-read=/usr/bin/ps','--allow-fs-read='+str(artifact),'--allow-addons','--allow-child-process','--redirect-warnings='+str(project/'warnings'/(profile+'.txt'))]
            return v
        stage='TYPESCRIPT'
        good(original('typescript',[str(node_copy),*node_flags('compiler',512),str(project/'compiler-entry.mjs')],60,tool='node',child_env={**env,'NODE_OPTIONS':''}))
        compiler_raw,compiler_pin=input_bytes(project/'compiler-result.json');compiler_observation=json_value(compiler_raw)
        need(compiler_observation['protocol']=='jev-selected-compiler-result-v1' and compiler_observation['status']=='COMPILED' and compiler_observation['policyRefused'] is False)
        compiler_integrity_raw,compiler_integrity_pin=input_bytes(project/'integrity-results/compiler.json');compiler_integrity=json_value(compiler_integrity_raw)
        keys(compiler_integrity,['protocol','profile','moduleBytes','compilerBytes','ownNodeBytes','addonPasses','nodeEntrants','refusal','workerDenied','lifetimeInstallCount'])
        need(compiler_integrity['protocol']=='jev-selected-process-integrity-v1' and compiler_integrity['profile']=='compiler' and type(compiler_integrity['lifetimeInstallCount']) is int)
        need(compiler_integrity['refusal'] is None and compiler_integrity['lifetimeInstallCount']==1 and compiler_integrity['workerDenied'] is True and compiler_integrity['addonPasses']==0 and compiler_integrity['nodeEntrants']==0 and compiler_integrity['ownNodeBytes']==0 and type(compiler_integrity['moduleBytes']) is int and 0<=compiler_integrity['moduleBytes']<=33554432)
        meter.child('modules',compiler_integrity['moduleBytes']);meter.child('compiler',compiler_integrity['compilerBytes'])
        meter.kind='native'
        stage='HEADER_DISCOVERY';headers=out/'headers';headers.mkdir(mode=0o700)
        # Execute the same verified header helper bytes through a retained FD.
        hf=out/'headers.py';write(hf,blobs['headers.py']);_,_,hfd,z=input_fd(hf)
        header_result=json_value(good(original('headers',[tool_paths['python'],'-B','-I','-S','/proc/self/fd/'+str(hfd),str(headers)],25,extra_fds=(hfd,),tool='python')),canonical=True)
        need(header_result['protocol']=='jev-owned-pair-headers-v1' and header_result['archiveSha256']==protocol['headerArchiveSha256'])
        need(set(header_result['selected'])=={'node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'})
        meter.child('headers',header_result['archiveBytes']+sum(v['bytes'] for v in header_result['selected'].values()))
        for n,p in header_result['selected'].items():_,actual=input_bytes(headers/n);need(actual==p)
        stage='DEPENDENCY_DISCOVERY';build=out/'build';build.mkdir(mode=0o700)
        direct=build/'direct';direct.mkdir(mode=0o700)
        direct_source=direct/'descriptor.c';write(direct_source,blobs['inputs/direct/descriptor.c']);_,direct_pin=input_bytes(direct_source);need(direct_pin==source_pins['inputs/direct/descriptor.c'])
        source=build/'relay.c';write(source,blobs['inputs/relay.c']);_,source_pin,sfd,z=input_fd(source);need(source_pin==source_pins['inputs/relay.c'])
        flags=['-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-DNAPI_VERSION=8','-DNODE_GYP_MODULE_NAME=jev_one_relay','-I',str(headers),'-I',str(build)]
        source_arg='/proc/self/fd/'+str(sfd)
        libc_source=build/'libc-contract.c';write(libc_source,blobs['libc-contract.c']);_,_,lfd,z=input_fd(libc_source);libc_exe=build/'libc-contract';libc_arg='/proc/self/fd/'+str(lfd)
        raw=good(original('dependencies',[tool_paths['cc'],*flags,'-x','c','-M','-MT','JEV_ONE_RELAY',source_arg,libc_arg],15,cap=131072,extra_fds=(sfd,lfd),tool='cc'))
        text=raw.decode('ascii').replace('\\\n',' ');parts=text.split('JEV_ONE_RELAY:');need(len(parts)==3 and parts[0]=='');tokens=' '.join(parts[1:]).split();need(1<=len(tokens)<=512)
        dependency_paths=[];dependencies=[]
        stage='DEPENDENCY_BINDING'
        for token in tokens:
            need(token.startswith('/') and all(c.isalnum() or c in '/_.+-' for c in token));p=source if token==source_arg else (libc_source if token==libc_arg else Path(token).resolve())
            if p in dependency_paths:continue
            need(p.is_absolute());raw,pin=input_bytes(p,512*1024*1024);dependency_paths.append(p);dependencies.append({'pathSha256':integrity_digest(str(p).encode()),**pin})
        need(source in dependency_paths and direct_source in dependency_paths and libc_source in dependency_paths and all((headers/n).resolve() in dependency_paths for n in header_result['selected']))
        stage='LIBC_BUILD'
        good(original('libc-build',[tool_paths['cc'],*flags,'-x','c',libc_arg,'-o',str(libc_exe)],20,extra_fds=(lfd,),tool='cc'))
        libc_bytes,libc_pin,libcfd,z=input_fd(libc_exe,8388608)
        stage='LIBC_ABI';need(good(original('libc-abi',[str(libc_exe)],5,execfd=libcfd))==b'JEV_PUBLIC_GLIBC_PIDFD_ABI_V1\n')
        stage='ADDON_BUILD';artifact=build/'relay.node'
        good(original('addon-build',[tool_paths['cc'],*flags,'-shared','-x','c',source_arg,'-o',str(artifact)],25,extra_fds=(sfd,),tool='cc'))
        stage='ARTIFACT_BINDING';artifact_bytes,artifact_pin=input_bytes(artifact,8388608)
        for p,expected in zip(dependency_paths,dependencies):
            _,current=input_bytes(p,512*1024*1024);need(current=={k:expected[k] for k in ['sha256','bytes']})
        meter.kind='late'
        stage='ENTRY_BINDING'
        # Fixed adjacent declarations are measured only after actual builds.
        composition=json_value(blobs['source-composition.json'],SOURCE_LIMIT)
        binding={'protocol':'jev-production-binding-v1','enabled':True,'artifact':str(artifact),'artifactSha256':artifact_pin['sha256'],'roleEntry':str(project/'bin/harmless-role.mjs'),'privateEntry':str(project/'bin/private-entry.mjs'),'provider':str(project/'provider.mjs'),'gateDirectory':str(project/'gates'),'nodeSha256':tools['node']['sha256'],'fixtureDeadlineUnixMs':int(time.time()*1000)+40000}
        (project/'binding.json').unlink()
        write(project/'binding.json',(json.dumps(binding,separators=(',',':'))+'\n').encode());_,binding_pin=input_bytes(project/'binding.json')
        write(project/'bin/harmless-role.mjs',blobs['role.mjs']);write(project/'bin/private-entry.mjs',blobs['private-entry.mjs'])
        emitted,emitted_pin=runtime_closure()
        declaration={'protocol':'private-routed-role-observer-build-v2','enabled':True,'artifact':str(artifact),'artifactSha256':artifact_pin['sha256'],'sourceCompositionSha256':source_pins['source-composition.json']['sha256'],'compiledSourceManifestSha256':emitted_pin['sha256']}
        write(project/'bin/private-role-observer-build.mjs',('export const ROLE_OBSERVER_BUILD = Object.freeze('+json.dumps(declaration,separators=(',',':'))+');\n').encode())
        runtime_rows,final_runtime_pin=runtime_closure();_,actual_runtime_pin=input_bytes(project/'runtime-closure.json');need(actual_runtime_pin==final_runtime_pin);_,declaration_pin=input_bytes(project/'bin/private-role-observer-build.mjs')
        # Lifetime child allowances were reserved before any original.
        child_hash_bound=budget[1]
        stage='FIXTURE'
        raw,err,code=original('fixture',[str(node_copy),*node_flags('fixture'),str(project/'fixture.mjs')],40,cap=CAP,child_env={**env,'NODE_OPTIONS':''},execfd=next(fd for fd,p,_ in held if p==node_copy))
        stage='RESULT_VALIDATION';result=canonical_fixture(raw,code,err)
        own_raw,own_pin=input_bytes(project/'own-metadata.json');own=json_value(own_raw,canonical=True)
        keys(own,['protocol','platform','architecture','kernel','credentials','procfs','namespaces','node','priorJobPermissionTransferred','continuousCoverage','providerAccessQualified','recoveryAccepted'])
        need(own['platform']=='LINUX' and own['architecture'] in ['X86_64','ARM64'] and own['priorJobPermissionTransferred'] is False and own['continuousCoverage'] is False)
        need(own['protocol']=='jev-production-owner-own-metadata-v1' and own['node']['sha256']==tools['node']['sha256'] and own['node']['version']=='22.23.0' and type(own['node']['bytes']) is int and own['node']['bytes']==tools['node']['bytes'] and own['providerAccessQualified'] is False and own['recoveryAccepted'] is False)
        process_integrity=[]
        expected={'fixture':(2,2),'positiveRole':(1,1),'parserRole':(1,0),'supervisor':(1,1),'provider':(0,0)}
        for profile,(loads,children) in expected.items():
            rr,rp=input_bytes(project/'integrity-results'/(profile+'.json'));v=json_value(rr)
            keys(v,['protocol','profile','moduleBytes','compilerBytes','ownNodeBytes','addonPasses','nodeEntrants','refusal','workerDenied','lifetimeInstallCount'])
            need(v['protocol']=='jev-selected-process-integrity-v1' and v['profile']==profile and v['refusal'] is None and v['workerDenied'] is True and type(v['lifetimeInstallCount']) is int and v['lifetimeInstallCount']==1)
            need(type(v['addonPasses']) is int and v['addonPasses']==loads and type(v['nodeEntrants']) is int and v['nodeEntrants']==children and type(v['moduleBytes']) is int and 0<=v['moduleBytes']<=33554432 and type(v['compilerBytes']) is int and v['compilerBytes']==0 and type(v['ownNodeBytes']) is int and v['ownNodeBytes']==(own['node']['bytes'] if profile=='fixture' else 0))
            meter.child('modules',v['moduleBytes']);meter.child('addons',loads*artifact_pin['bytes']);process_integrity.append({'profile':profile,**rp,'moduleBytes':v['moduleBytes'],'addonPasses':loads,'nodeEntrants':children})
        meter.child('ownNode',own['node']['bytes'])
        # Warnings are retained privately in full; no suppression or wildcard stderr allowance.
        warning_receipts=[]
        import re
        for label,processes in [('fixture',1),('positiveRole',1),('parserRole',1),('supervisor',1),('provider',1)]:
            wr,wp=input_bytes(project/'warnings'/(label+'.txt'));need(len(wr)<=65536)
            text=wr.decode('ascii');matched=re.findall(r'\(node:([1-9][0-9]{0,9})\) SecurityWarning: The flag (--allow-addons|--allow-child-process) must be used with extreme caution\. It could invalidate the permission model\.\n',text)
            hints=re.findall(r'\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n',text)
            stripped=re.sub(r'\(node:([1-9][0-9]{0,9})\) SecurityWarning: The flag (--allow-addons|--allow-child-process) must be used with extreme caution\. It could invalidate the permission model\.\n','',text)
            stripped=re.sub(r'\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n','',stripped)
            need(stripped=='' and len(hints)==(processes if label!='provider' else 0) and len(set(pid for pid,_ in matched))==(processes if label!='provider' else 0))
            wanted=[] if label=='provider' else ['--allow-addons'] if label=='parserRole' else ['--allow-addons','--allow-child-process']
            for pid in set(pid for pid,_ in matched):need(sorted(flag for p,flag in matched if p==pid)==sorted(wanted))
            warning_receipts.append({'slot':label,**wp,'expectedProcessRecords':processes,'warningMessages':len(matched),'hintRecords':len(hints),'classification':'EXACT_NODE22_23_SECURITY_WARNINGS'})
        stage='SOURCE_RECHECK'
        for name,before in blobs.items():raw,after=input_bytes(root/name);need(after==source_pins[name] and raw==before)
        for fd,p,z in held:need(shape(z)==shape(os.fstat(fd))==shape(p.lstat()))
        for rel,expected in [('binding.json',binding_pin),('runtime-closure.json',final_runtime_pin),('bin/private-role-observer-build.mjs',declaration_pin)]:
            _,after=input_bytes(project/rel,SOURCE_LIMIT);need(after==expected)
        installed_names={d['relative'] for d in dependency_rows}
        for row in runtime_rows:
            if row['relative'] not in installed_names:
                _,after=input_bytes(project/row['relative'],16777216);need(after=={k:row[k] for k in ['sha256','bytes']})
        # Per-file stat closure, not a compiler-distribution execution-byte claim.
        # Runtime imports separately hash and execute the same read bytes.
        # Selected copied inputs remain in the sealed source-owned execution tree.
        need(not interrupted[0] and time.monotonic()<deadline and budget[0]+budget[1]<=HASH_TOTAL and [r['slot'] for r in receipts]==SLOTS and all(r['directOriginalTerminal'] is True and r['directOriginalReaped'] is True and r['exitCode']==0 and r['signalsSent']==0 and not r['streamTruncated'] and r['ownedPipesEOF'] is True for r in receipts))
        stage='CLEANUP';need(close_inputs())
        stage='RESULT_RETENTION'
        summary={'selectedAuthority':{'protocol':'jev-selected-consumed-input-authority-v1','equivalentFullInventory':False,'selectedBytes':None if selection is None else selection['selectedBytes'],'metadataSnapshotOnly':True},'protocol':'jev-production-owner-qualification-result-v1','status':'SUPPORTED' if code==0 else 'UNSUPPORTED','stage':stage,'fixture':result,'originals':receipts,'sourceManifestSha256':m_pin['sha256'],'sourcePins':source_pins,'context':ctx,'tools':tools,'headers':header_result,'selectedDependencyCount':len(dependencies),'selectedDependenciesSha256':integrity_digest(json.dumps(dependencies,separators=(',',':')).encode()),'artifact':artifact_pin,'libcContract':libc_pin,'ownMetadata':own,'ownMetadataPin':own_pin,'hashBudget':meter.report(),'processIntegrity':process_integrity,'warningReceipts':warning_receipts,'compilerResultPin':compiler_pin,'currentSourceComposition':source_pins['source-composition.json'],'trackedCompileInputCount':len(source_observations),'dependencyInventorySha256':integrity_digest(json.dumps(dependency_rows,separators=(',',':')).encode()),'emittedBeforeDeclaration':emitted_pin,'runtimeModuleClosure':final_runtime_pin,'privateBinding':binding_pin,'privateBuildDeclaration':declaration_pin,'ordinaryCompilationCompleted':True,'inputFDsClosed':True,'deadlineReached':False,'interrupted':False,'platformRuntimeTrustRequired':True,'compilerDistributionQualified':False,'globalGroupAbsenceClaimed':False,'providerAccessQualified':False,'recoveryAccepted':False}
        summary['hashBudget']=meter.report()
        # Private raw streams and dependency paths never enter the result.
        save(out/'dependency-closure.private.json',{'paths':[str(p) for p in dependency_paths],'pins':dependencies})
        save(out/'result.json',summary)
        need(not interrupted[0] and time.monotonic()<deadline)
        print('JEV_PRODUCTION_OWNER_COMPLETE' if code==0 else 'JEV_PRODUCTION_OWNER_UNSUPPORTED');return code
    except BaseException as error:
        if CLOSE_UNCERTAIN or selection_custody['cleanupKnown'] is not True:hold_without_authority()
        if active:hold_without_authority()
        if not close_inputs():hold_without_authority()
        if out:
            try:save(out/'result.json',{'selectedAuthority':{'protocol':'jev-selected-consumed-input-authority-v1','equivalentFullInventory':False,'selectedBytes':None if selection is None else selection['selectedBytes'],'metadataSnapshotOnly':True},'protocol':'jev-production-owner-qualification-result-v1','status':'REFUSED','stage':stage if stage in STAGES else 'UNKNOWN','originals':receipts,'deadlineReached':time.monotonic()>=deadline,'interrupted':interrupted[0],'nativeQualified':False,'providerAccessQualified':False,'recoveryAccepted':False,'globalGroupAbsenceClaimed':False,'fixtureDiagnostic':None if result is None else {k:result[k] for k in ['status','stage','code','cleanupKnown','roleTerminalObserved']},'hashBudget':None if meter is None else meter.report(),'postSelectionDiagnostic':catalog_snapshot(post_catalog,error,stage)})
            except BaseException:pass
        print('JEV_PRODUCTION_OWNER_REFUSED',file=sys.stderr);return 2
    finally:
        if not close_inputs():raise RuntimeError('PRODUCTION_OWNER_REFUSED')
