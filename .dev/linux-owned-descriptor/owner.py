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
TOTAL_SECONDS=150
CLEANUP_SECONDS=10
SOURCE_LIMIT=65536
HASH_TOTAL=1024*1024*1024
SLOTS=['headers','dependencies','libc-build','libc-abi','addon-build','fixture']
CASE_NAMES=['DIRECT_OWNER_FRESH_ENDPOINT','CLOSED_HANDLE_REFUSED','UNOWNED_HANDLE_REFUSED','NESTED_GENUINE_OWNER_FRESH_ENDPOINT']
STAGES=['ADMISSION','SOURCE_BINDING','TOOL_BINDING','HEADER_DISCOVERY','DEPENDENCY_DISCOVERY','DEPENDENCY_BINDING','LIBC_BUILD','LIBC_ABI','ADDON_BUILD','ARTIFACT_BINDING','ENTRY_BINDING','FIXTURE','RESULT_VALIDATION','SOURCE_RECHECK','RESULT_RETENTION','CLEANUP','UNKNOWN']

def need(v):
    if not v:raise RuntimeError('OWNED_PAIR_OWNER_REFUSED')
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
            count+=len(b);budget[0]+=len(b);need(count<=cap and budget[0]<=HASH_TOTAL);h.update(b);chunks.append(b)
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
    need(code in [0,2] and err==b'');x=json_value(raw,1024,True)
    keys(x,['protocol','status','stage','code','cases','cleanupKnown','sequentialEndpointOnly','nativeRecoveryAccepted'])
    need(x['protocol']=='jev-owned-spawn-pair-fixture-v1' and x['sequentialEndpointOnly'] is True and x['nativeRecoveryAccepted'] is False)
    need(type(x['cleanupKnown']) is bool and type(x['cases']) is list and x['cases']==CASE_NAMES[:len(x['cases'])])
    need(type(x['stage']) is str and x['stage'] in ['LOAD','DIRECT_CHANNEL','DIRECT_SPAWN_BIND','DIRECT_SEND_RECEIVE','DIRECT_READY','DIRECT_ENDPOINT','CLOSED_HANDLE','UNOWNED_HANDLE','DIRECT_SETTLEMENT','NESTED_CHANNEL','NESTED_OWNER_BIND','NESTED_READY','NESTED_RECEIVE','NESTED_ENDPOINT','NESTED_SETTLEMENT','CLEANUP'])
    enums=['ARGUMENT','OWNERSHIP','UNSUPPORTED','ALLOCATION','FILESYSTEM','IDENTITY','CLEANUP','NAPI','CLOSED','CHANNEL','PAIR','ACCESS','SHAPE','CAP','COUNT','STATE','SET_CHANGED','UID','DUPLICATE','DEADLINE','UNKNOWN','FIXTURE']
    if code==0:need(x['status']=='SUPPORTED' and x['stage']=='NESTED_SETTLEMENT' and x['code']=='NOT_APPLICABLE' and x['cases']==CASE_NAMES and x['cleanupKnown'] is True)
    else:need(x['status']=='UNSUPPORTED' and x['code'] in enums)
    return x

def main(admission_path):
    os.umask(0o077)
    need(sys.platform=='linux' and all(hasattr(os,k) for k in ['waitid','WNOWAIT','WEXITED','WNOHANG','P_PID']))
    root=Path(__file__).resolve().parent;deadline=time.monotonic()+TOTAL_SECONDS;budget=[0];held=[];receipts=[];stage='ADMISSION';out=None;active=None;interrupted=[False]
    def interrupt(_s,_f):interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    def input_bytes(path,cap=SOURCE_LIMIT):
        raw,pin,fd,a=read(path,cap,deadline,budget);held.append((fd,path,a));return raw,pin
    def unknown():
        if out:
            try:save(out/'unknown-hold.json',{'protocol':'jev-owned-pair-owner-unknown-v1','status':'UNKNOWN_HOLD','stage':stage,'originalSlot':active['slot'] if active else 'UNKNOWN','nativeQualified':False,'recoveryAccepted':False})
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
        keys(admission,['protocol','executionAdmitted','scope','sourceManifestSha256','context','tools','outputParent','outputName'])
        need(admission['protocol']=='jev-owned-pair-qualification-admission-v1' and admission['executionAdmitted'] is True and admission['scope']=='HARMLESS_OWNED_PAIR_ONLY');sha(admission['sourceManifestSha256'])
        ctx=admission['context'];keys(ctx,['repository','head','base','runId','runAttempt','job'])
        need(ctx['repository']=='typicalday/owenloop' and ctx['base']=='b4ead192326ba607558cd3bb7687209cbb7c8165' and ctx['job']=='linux-owned-descriptor-qualification')
        need(type(ctx['head']) is str and len(ctx['head'])==40 and all(c in '0123456789abcdef' for c in ctx['head']))
        for k,cap in [('runId',20),('runAttempt',6)]:need(type(ctx[k]) is str and ctx[k].isascii() and ctx[k].isdigit() and 1<=len(ctx[k])<=cap and not ctx[k].startswith('0'))
        parent=Path(admission['outputParent']);name=admission['outputName']
        need(parent.is_absolute() and parent.is_dir() and not parent.is_symlink())
        need(type(name) is str and name.startswith('jev-owned-pair-qualification-') and len(name)<=96 and all(c.isalnum() or c=='-' for c in name))
        out=parent/name;out.mkdir(mode=0o700)
        stage='SOURCE_BINDING';m_raw,m_pin=input_bytes(root/'manifest.json');need(m_pin['sha256']==admission['sourceManifestSha256']);manifest=json_value(m_raw)
        blobs={};source_pins={}
        for r in manifest['executionFiles']:
            need(type(r['relative']) is str and not Path(r['relative']).is_absolute() and '..' not in Path(r['relative']).parts)
            raw,p=input_bytes(root/r['relative']);need(p=={'sha256':r['sha256'],'bytes':r['bytes']});blobs[r['relative']]=raw;source_pins[r['relative']]=p
        required=['owner.py','launch.py','headers.py','loader.mjs','entry.mjs','libc-contract.c','protocol.json','dependencies/owner.py','dependencies/metadata.mjs','inputs/descriptor.c','inputs/facade.mjs','inputs/fixture.mjs','inputs/nested-owner.mjs','inputs/target.mjs']
        need(set(blobs)==set(required))
        protocol=json_value(blobs['protocol.json']);need(protocol['protocol']=='jev-owned-pair-qualification-source-v1' and protocol['executionAdmitted'] is False)
        ns={'__name__':'jev_verified_original_custody','__file__':str(root/'dependencies/owner.py')}
        exec(compile(blobs['dependencies/owner.py'],ns['__file__'],'exec'),ns)
        base=types.SimpleNamespace(**ns);base.CLEANUP_SECONDS=CLEANUP_SECONDS
        stage='TOOL_BINDING';keys(admission['tools'],['node','cc'])
        tools={};tool_fds={};tool_paths={}
        for label,p in [('node',Path(admission['tools']['node'])),('cc',Path(admission['tools']['cc'])),('python',Path(sys.executable))]:
            need(p.is_absolute());p=p.resolve();raw,pin,fd,z=read(p,512*1024*1024,deadline,budget);held.append((fd,p,z));tool_fds[label]=fd;tool_paths[label]=str(p);tools[label]={**pin,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'}
            if label=='node':
                # A dedicated private executable path for genuine nested cp.spawn.
                node_copy=out/'node';write(node_copy,raw,0o700);node_raw,node_pin=input_bytes(node_copy,512*1024*1024);need(node_pin==pin)
        env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC'}
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
                try:raw,err,code=base.drive_original(c,channel,min(deadline,time.monotonic()+seconds),interrupted,unknown)
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
        stage='HEADER_DISCOVERY';headers=out/'headers';headers.mkdir(mode=0o700)
        # Execute the same verified header helper bytes through a retained FD.
        hf=out/'headers.py';write(hf,blobs['headers.py']);_,_,hfd,z=read(hf,SOURCE_LIMIT,deadline,budget);held.append((hfd,hf,z))
        header_result=json_value(good(original('headers',[tool_paths['python'],'-B','-I','-S','/proc/self/fd/'+str(hfd),str(headers)],25,extra_fds=(hfd,),tool='python')),canonical=True)
        need(header_result['protocol']=='jev-owned-pair-headers-v1' and header_result['archiveSha256']==protocol['headerArchiveSha256'])
        need(set(header_result['selected'])=={'node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'})
        for n,p in header_result['selected'].items():_,actual=input_bytes(headers/n);need(actual==p)
        stage='DEPENDENCY_DISCOVERY';build=out/'build';build.mkdir(mode=0o700)
        source=build/'descriptor.c';write(source,blobs['inputs/descriptor.c']);_,source_pin,sfd,z=read(source,SOURCE_LIMIT,deadline,budget);held.append((sfd,source,z));need(source_pin==source_pins['inputs/descriptor.c'])
        flags=['-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIC','-DNAPI_VERSION=8','-DNODE_GYP_MODULE_NAME=jev_owned_pair','-I',str(headers)]
        source_arg='/proc/self/fd/'+str(sfd)
        libc_source=build/'libc-contract.c';write(libc_source,blobs['libc-contract.c']);_,_,lfd,z=read(libc_source,SOURCE_LIMIT,deadline,budget);held.append((lfd,libc_source,z));libc_exe=build/'libc-contract';libc_arg='/proc/self/fd/'+str(lfd)
        raw=good(original('dependencies',[tool_paths['cc'],*flags,'-x','c','-M','-MT','JEV_OWNED_PAIR',source_arg,libc_arg],15,cap=131072,extra_fds=(sfd,lfd),tool='cc'))
        text=raw.decode('ascii').replace('\\\n',' ');parts=text.split('JEV_OWNED_PAIR:');need(len(parts)==3 and parts[0]=='');tokens=' '.join(parts[1:]).split();need(1<=len(tokens)<=512)
        dependency_paths=[];dependencies=[]
        stage='DEPENDENCY_BINDING'
        for token in tokens:
            need(token.startswith('/') and all(c.isalnum() or c in '/_.+-' for c in token));p=source if token==source_arg else (libc_source if token==libc_arg else Path(token).resolve())
            if p in dependency_paths:continue
            need(p.is_absolute());raw,pin=input_bytes(p,512*1024*1024);dependency_paths.append(p);dependencies.append({'pathSha256':hashlib.sha256(str(p).encode()).hexdigest(),**pin})
        need(source in dependency_paths and libc_source in dependency_paths and all((headers/n).resolve() in dependency_paths for n in header_result['selected']))
        stage='LIBC_BUILD'
        good(original('libc-build',[tool_paths['cc'],*flags,'-x','c',libc_arg,'-o',str(libc_exe)],20,extra_fds=(lfd,),tool='cc'))
        libc_bytes,libc_pin,libcfd,z=read(libc_exe,8388608,deadline,budget);held.append((libcfd,libc_exe,z))
        stage='LIBC_ABI';need(good(original('libc-abi',[str(libc_exe)],5,execfd=libcfd))==b'JEV_PUBLIC_GLIBC_PIDFD_ABI_V1\n')
        stage='ADDON_BUILD';artifact=build/'descriptor.node'
        good(original('addon-build',[tool_paths['cc'],*flags,'-shared','-x','c',source_arg,'-o',str(artifact)],25,extra_fds=(sfd,),tool='cc'))
        stage='ARTIFACT_BINDING';artifact_bytes,artifact_pin=input_bytes(artifact,8388608)
        for p,expected in zip(dependency_paths,dependencies):
            _,current=input_bytes(p,512*1024*1024);need(current=={k:expected[k] for k in ['sha256','bytes']})
        stage='ENTRY_BINDING';entry=out/'entry';entry.mkdir(mode=0o700);verified=entry/'verified';verified.mkdir(mode=0o700)
        for n in ['fixture.mjs','target.mjs','nested-owner.mjs']:write(entry/n,blobs['entry.mjs'])
        write(entry/'loader.mjs',blobs['loader.mjs'])
        for n in ['facade.mjs','metadata.mjs']:
            raw=blobs['inputs/'+n] if n=='facade.mjs' else blobs['dependencies/metadata.mjs'];write(entry/n,raw)
        for n in ['fixture.mjs','target.mjs','nested-owner.mjs','facade.mjs']:write(verified/n,blobs['inputs/'+n])
        write(verified/'metadata.mjs',blobs['dependencies/metadata.mjs'])
        # Fixed four-process source map: fixture, direct target, nested owner, nested target.
        child_hash_bound=tools['node']['bytes']+4*sum(source_pins[k]['bytes'] for k in ['inputs/fixture.mjs','inputs/target.mjs','inputs/nested-owner.mjs','inputs/facade.mjs','dependencies/metadata.mjs'])+2*artifact_pin['bytes']
        need(budget[0]+child_hash_bound<=HASH_TOTAL)
        stage='FIXTURE';fixture_env={**env,'JEV_DESCRIPTOR_ARTIFACT':str(artifact),'JEV_DESCRIPTOR_SHA':artifact_pin['sha256'],'JEV_NODE_IMAGE_SHA':tools['node']['sha256'],'JEV_OWN_METADATA_PATH':str(out/'own-metadata.json')}
        raw,err,code=original('fixture',[str(node_copy),str(entry/'fixture.mjs')],40,cap=CAP,child_env=fixture_env,execfd=next(fd for fd,p,_ in held if p==node_copy))
        stage='RESULT_VALIDATION';result=canonical_fixture(raw,code,err)
        own_raw,own_pin=input_bytes(out/'own-metadata.json');own=json_value(own_raw,canonical=True)
        keys(own,['protocol','platform','architecture','kernel','credentials','procfs','namespaces','node','priorJobPermissionTransferred','continuousCoverage','providerAccessQualified','recoveryAccepted'])
        need(own['platform']=='LINUX' and own['architecture'] in ['X86_64','ARM64'] and own['priorJobPermissionTransferred'] is False and own['continuousCoverage'] is False)
        need(own['protocol']=='jev-owned-pair-own-metadata-v1' and own['node']['sha256']==tools['node']['sha256'] and own['node']['version']=='22.23.0' and own['providerAccessQualified'] is False and own['recoveryAccepted'] is False)
        stage='SOURCE_RECHECK'
        for name,before in blobs.items():raw,after=input_bytes(root/name);need(after==source_pins[name] and raw==before)
        for fd,p,z in held:need(shape(z)==shape(os.fstat(fd))==shape(p.lstat()))
        need(not interrupted[0] and time.monotonic()<deadline and budget[0]+child_hash_bound<=HASH_TOTAL and len(receipts)==6 and all(r['signalsSent']==0 and not r['streamTruncated'] and r['ownedPipesEOF'] for r in receipts))
        stage='CLEANUP';need(close_inputs())
        stage='RESULT_RETENTION'
        summary={'protocol':'jev-owned-pair-qualification-result-v1','status':'SUPPORTED' if code==0 else 'UNSUPPORTED','stage':stage,'fixture':result,'originals':receipts,'sourceManifestSha256':m_pin['sha256'],'sourcePins':source_pins,'context':ctx,'tools':tools,'headers':header_result,'selectedDependencyCount':len(dependencies),'selectedDependenciesSha256':hashlib.sha256(json.dumps(dependencies,separators=(',',':')).encode()).hexdigest(),'artifact':artifact_pin,'libcContract':libc_pin,'ownMetadata':own,'ownMetadataPin':own_pin,'hashBudget':{'ownerSelectedBytes':budget[0],'fixtureAdditionalBoundBytes':child_hash_bound,'totalCapBytes':HASH_TOTAL},'inputFDsClosed':True,'deadlineReached':False,'interrupted':False,'platformRuntimeTrustRequired':True,'compilerDistributionQualified':False,'globalGroupAbsenceClaimed':False,'providerAccessQualified':False,'recoveryAccepted':False}
        # Private raw streams and dependency paths never enter the result.
        save(out/'dependency-closure.private.json',{'paths':[str(p) for p in dependency_paths],'pins':dependencies})
        save(out/'result.json',summary)
        need(not interrupted[0] and time.monotonic()<deadline)
        print('JEV_OWNED_PAIR_COMPLETE' if code==0 else 'JEV_OWNED_PAIR_UNSUPPORTED');return code
    except BaseException:
        if active:hold_without_authority()
        if not close_inputs():stage='CLEANUP'
        if out:
            try:save(out/'result.json',{'protocol':'jev-owned-pair-qualification-result-v1','status':'REFUSED','stage':stage if stage in STAGES else 'UNKNOWN','originals':receipts,'deadlineReached':time.monotonic()>=deadline,'interrupted':interrupted[0],'nativeQualified':False,'providerAccessQualified':False,'recoveryAccepted':False,'globalGroupAbsenceClaimed':False})
            except BaseException:pass
        print('JEV_OWNED_PAIR_OWNER_REFUSED',file=sys.stderr);return 2
    finally:
        if not close_inputs():raise RuntimeError('OWNED_PAIR_OWNER_REFUSED')
