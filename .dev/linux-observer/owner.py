import hashlib
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tarfile
import time
import types
import urllib.request

CAP=65536
TOTAL_SECONDS=120
CLEANUP_SECONDS=10
HEADER_SHA='ac07673009b92d70f3d842df28204e92785234bae6b4d5785f63fbca8408fc69'
BASE_OWNER_SHA='7207411dae463c0c589e2cfd893365c9401e5d23b7c9058b35dd02224c84dc4f'
BASE_METADATA_SHA='e1c31a4c7f6fa05b58d08f5c5d18109397a48ea079a39dce7bb4667cca966a8b'

def need(value):
    if not value: raise RuntimeError('OBSERVER_OWNER_REFUSED')

def shape(s):
    return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'))

def source(path,expected):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and 0<a.st_size<=CAP)
        raw=b''
        while True:
            b=os.read(fd,8192)
            if not b:break
            raw+=b;need(len(raw)<=CAP)
        need(shape(a)==shape(os.fstat(fd))==shape(path.lstat()))
        need(hashlib.sha256(raw).hexdigest()==expected)
        return raw
    finally:os.close(fd)

def canonical(raw):
    def pairs(xs):
        d={}
        for k,v in xs:need(k not in d);d[k]=v
        return d
    need(0<len(raw)<=CAP)
    x=json.loads(raw.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda _:need(False))
    need((json.dumps(x,separators=(',',':'),ensure_ascii=False)+'\n').encode()==raw)
    return x

def keys(x,wanted):need(type(x) is dict and set(x)==set(wanted))
def sha(x):need(type(x) is str and len(x)==64 and all(c in '0123456789abcdef' for c in x))
def count(x,lo,hi):need(type(x) is int and lo<=x<=hi)

def decode_result(raw,code,stderr):
    need(code in [0,2] and not stderr);x=canonical(raw)
    if code==2:
        keys(x,['protocol','status','refusal','stage','recoveryAccepted'])
        need(x['protocol']=='jev-linux-procfs-observer-result-v2' and x['status']=='UNSUPPORTED' and x['recoveryAccepted'] is False)
        need(x['refusal'] in ['ARGUMENT','CLOSED','UID','ACCESS','FILESYSTEM','ALLOCATION','NAPI','DEADLINE','SHAPE','CAP','COUNT','STATE','DUPLICATE','IDENTITY','SET_CHANGED','CLEANUP','UNKNOWN'])
        need(x['stage'] in ['METADATA_BINDING','ARTIFACT_BINDING','METADATA_LOAD','OWN_METADATA','ARTIFACT_LOAD','API_NEGATIVE','NATIVE_ACQUIRE','NATIVE_SAMPLE','NATIVE_CLOSE','CLOSED_HANDLE_CHECK','SOURCE_RECHECK','RESULT_EMIT','CLEANUP','UNKNOWN'])
        return x
    keys(x,['protocol','status','job','runId','runAttempt','node','own','observation','negativeControls','artifact','originalAuthority','continuousCoverage','atomicCoverage','darwinEquivalence','providerAccessQualified','recoveryAccepted'])
    need(x['protocol']=='jev-linux-procfs-observer-result-v2' and x['status']=='SUPPORTED_ENDPOINT_OBSERVATION' and x['job']=='linux-procfs-observer')
    need(x['originalAuthority']=='LIVE_UNREAPED_ORIGINAL_OWNER_REQUIRED')
    for k in ['continuousCoverage','atomicCoverage','darwinEquivalence','providerAccessQualified','recoveryAccepted']:need(x[k] is False)
    need(x['negativeControls']==['zero','null','forged-handle','closed-handle'])
    keys(x['node'],['version','napi','architecture','provenance'])
    need(x['node']=={'version':'22.23.0','napi':10,'architecture':'X86_64','provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'})
    o=x['observation'];keys(o,['count','twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown']);count(o['count'],2,127)
    for k in set(o)-{'count'}:need(o[k] is True)
    a=x['artifact'];keys(a,['sha256','bytes']);sha(a['sha256']);count(a['bytes'],1,8388608)
    own=x['own'];keys(own,['kernel','credentials','procfs','namespaces'])
    k=own['kernel'];keys(k,['releaseSha256','releaseBytes','numericVersion','exactVersionRetained']);sha(k['releaseSha256']);count(k['releaseBytes'],1,256);need(k['exactVersionRetained'] is False)
    need(type(k['numericVersion']) is list and len(k['numericVersion'])==3)
    for v in k['numericVersion']:count(v,0,99999)
    c=own['credentials'];keys(c,['uid','gid','supplementaryGroupCount','supplementaryGroupSetSha256','capabilities','noNewPrivileges','seccomp'])
    for label in ['uid','gid']:need(c[label]=={'fourEqual':True,'allNonzero':True})
    count(c['supplementaryGroupCount'],0,64);sha(c['supplementaryGroupSetSha256']);need(type(c['noNewPrivileges']) is bool and c['seccomp'] in ['DISABLED','STRICT','FILTER'])
    keys(c['capabilities'],['inheritable','permitted','effective','bounding','ambient']);need(all(v in ['ZERO','NONZERO'] for v in c['capabilities'].values()))
    p=own['procfs'];keys(p,['filesystem','hidepid','subset','readOnly','optionsSha256']);need(p['filesystem']=='PROCFS' and p['hidepid'] in ['NOT_DECLARED','0','1','2','4'] and p['subset'] in ['PID','NOT_DECLARED'] and type(p['readOnly']) is bool);sha(p['optionsSha256'])
    need(type(own['namespaces']) is list and len(own['namespaces'])==3)
    for n,label in zip(own['namespaces'],['pid','mnt','user']):
        keys(n,['kind','identitySha256','stableAcrossTwoReads']);need(n['kind']==label and n['stableAcrossTwoReads'] is True);sha(n['identitySha256'])
    return x

def context(env):
    fixed={'JEV_REPOSITORY':'typicalday/owenloop','JEV_HEAD_REPOSITORY':'typicalday/owenloop','JEV_PR':'369','JEV_BRANCH':'jev-routing-foundation-20261008','JEV_EVENT':'pull_request','JEV_ACTION':'synchronize','JEV_BASE':'b4ead192326ba607558cd3bb7687209cbb7c8165','JEV_JOB':'linux-procfs-observer'}
    need(all(env.get(k)==v for k,v in fixed.items()) and env.get('JEV_PREFLIGHT_ADMITTED_HEAD','')=='')
    head=env.get('JEV_HEAD','');need(len(head)==40 and all(c in '0123456789abcdef' for c in head) and env.get('JEV_ADMITTED_HEAD')==head)
    for k,cap in [('JEV_RUN_ID',20),('JEV_RUN_ATTEMPT',6)]:
        v=env.get(k,'');need(v.isascii() and v.isdigit() and 1<=len(v)<=cap and not v.startswith('0'))
    return {**fixed,**{k:env[k] for k in ['JEV_HEAD','JEV_ADMITTED_HEAD','JEV_RUN_ID','JEV_RUN_ATTEMPT']}}

def write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        view=memoryview(data)
        while view:
            n=os.write(fd,view);need(n>0);view=view[n:]
        os.fsync(fd)
    finally:os.close(fd)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):raise RuntimeError('HEADER_REDIRECT_REFUSED')

def headers(out,deadline):
    # Only four declared public N-API headers; no archive extractall or links.
    opener=urllib.request.build_opener(NoRedirect)
    raw=b''
    with opener.open('https://nodejs.org/dist/v22.23.0/node-v22.23.0-headers.tar.gz',timeout=10) as response:
        need(response.status==200)
        while True:
            need(time.monotonic()<=deadline);b=response.read(65536)
            if not b:break
            raw+=b;need(len(raw)<=16*1024*1024)
    need(hashlib.sha256(raw).hexdigest()==HEADER_SHA)
    names={'node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'};found={};entries=0;total=0
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        for item in archive:
            need(time.monotonic()<=deadline);entries+=1;total+=item.size;need(entries<=8192 and 0<=item.size<=16*1024*1024 and total<=128*1024*1024)
            prefix='node-v22.23.0/include/node/'
            if item.name.startswith(prefix) and item.name[len(prefix):] in names:
                name=item.name[len(prefix):];need(name not in found and item.isfile() and item.size<=CAP)
                with archive.extractfile(item) as stream:data=stream.read(CAP+1)
                need(len(data)==item.size);write(out/name,data);found[name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
    need(set(found)==names);return {'archiveSha256':HEADER_SHA,'selected':found,'archiveBytes':len(raw),'archiveEntries':entries}

def dependency_paths(raw,target):
    need(0<len(raw)<=CAP);text=raw.decode('ascii').replace('\\\n',' ')
    prefix=str(target)+':';need(text.startswith(prefix));tokens=text[len(prefix):].split();need(1<=len(tokens)<=512)
    result=[]
    for token in tokens:
        need(token.startswith('/') and all(c.isalnum() or c in '/_.+-' for c in token))
        p=Path(token).resolve();need(p.is_file())
        if p not in result:result.append(p)
    return result

def main():
    os.umask(0o077);need(sys.platform=='linux' and len(sys.argv)==1)
    need(all(hasattr(os,k) for k in ['waitid','WNOWAIT','WEXITED','WNOHANG','P_PID']))
    ctx=context(os.environ);root=Path(__file__).resolve().parent;need(root.name=='linux-observer' and root.parent.name=='.dev')
    checkout=root.parent.parent;tmp=Path(os.environ.get('RUNNER_TEMP',''));need(tmp.is_absolute() and tmp.is_dir() and not tmp.is_symlink())
    out=tmp/'jev-linux-procfs-observer-v2';out.mkdir(mode=0o700);deadline=time.monotonic()+TOTAL_SECONDS
    interrupted=[False]
    def interrupt(_s,_f):interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    expected={n:os.environ['JEV_EXPECTED_'+key+'_SHA'] for n,key in [('owner.py','OWNER'),('protocol.json','PROTOCOL'),('observer.c','CORE'),('observer.mjs','OBSERVER'),('target.mjs','TARGET'),('controls.mjs','CONTROLS')]}
    blobs={n:source(root/n,h) for n,h in expected.items()}
    protocol=json.loads(blobs['protocol.json']);need(protocol['protocol']=='jev-linux-procfs-observer-source-v2' and protocol['executionAdmitted'] is False)
    dep=root.parent/'linux-metadata';lib_raw=source(dep/'owner.py',BASE_OWNER_SHA);source(dep/'metadata.mjs',BASE_METADATA_SHA)
    ns={'__name__':'jev_verified_metadata_custody','__file__':str(dep/'owner.py')};exec(compile(lib_raw,str(dep/'owner.py'),'exec'),ns)
    base=types.SimpleNamespace(**ns) # Exact read/hash-verified bytes; old main/context never called.
    base.CLEANUP_SECONDS=CLEANUP_SECONDS
    node=Path(os.environ.get('JEV_NODE_EXECUTABLE','')).resolve();git=Path(os.environ.get('JEV_GIT_EXECUTABLE','')).resolve();cc=Path('/usr/bin/cc').resolve()
    need(node.is_file() and git.is_file() and cc.is_file())
    tools={};budget=0
    def pin(path,cap=512*1024*1024):
        nonlocal budget
        x=base.tool_hash(path,deadline,budget,cap);budget+=x['bytes'];return x
    for label,path in [('node',node),('git',git),('python',Path(sys.executable).resolve()),('cc',cc)]:tools[label]=pin(path)
    env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC',**ctx}
    git_env={**env,'GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
    stage='TOOL_BINDING'
    receipts=[];target=None;target_channel=None;target_custody=None;observer=None;c=None;channel=None
    class OwnedChannel(base.PipeChannel):
        def close(self):
            if getattr(self,'closed',False):return
            try:self.terminal_eof=self.eof()
            except BaseException:self.terminal_eof=False
            self.closed=True
            failures=[]
            if self.selector is not None:
                try:self.selector.close()
                except BaseException:failures.append(True)
            for stream in (self.proc.stdout,self.proc.stderr):
                try:stream.close()
                except BaseException:failures.append(True)
            for fd in self.fds.values():
                try:os.close(fd)
                except BaseException:failures.append(True)
            need(not failures)
        def open(self):
            if self.opened:return
            super().open()
    def retain_receipt(slot,custody,pipes):
        # Only retained originals; no PID/PGID/path or stream contents serialized.
        raw,err=pipes.output();need(len(raw)<=CAP and len(err)<=CAP)
        eof=pipes.terminal_eof if getattr(pipes,'closed',False) else pipes.eof()
        record={'slot':slot,'directOriginalTerminal':custody.reaped,'directOriginalReaped':custody.reaped,
            'ownedPipesEOF':bool(eof),'signalsSent':custody.signals,'globalGroupAbsenceClaimed':False,
            'exitCode':custody.proc.returncode if custody.reaped else None,
            'stdoutBytes':len(raw),'stdoutSha256':hashlib.sha256(raw).hexdigest(),
            'stderrBytes':len(err),'stderrSha256':hashlib.sha256(err).hexdigest()}
        for i,previous in enumerate(receipts):
            if previous['slot']==slot:receipts[i]=record;break
        else:receipts.append(record)
        order=['head','tree','clean','controls','dependencies','compile','target','observer']
        receipts.sort(key=lambda r:order.index(r['slot']));need(len(receipts)<=8)
    def original(argv,slot,seconds=10,child_env=None):
        nonlocal stage
        stage={'head':'GIT_HEAD','tree':'GIT_TREE','clean':'GIT_CLEAN','controls':'PURE_CONTROLS','dependencies':'DEPENDENCY_DISCOVERY','compile':'COMPILE'}[slot]
        proc=subprocess.Popen(argv,cwd=checkout,env=child_env or env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True)
        custody=base.OriginalCustody(proc);pipes=OwnedChannel(proc,out,slot)
        try:
            raw,err,code=base.drive_original(custody,pipes,min(deadline,time.monotonic()+seconds),interrupted,retain_unknown)
            need(code==0 and err==b'');return raw
        finally:
            try:retain_receipt(slot,custody,pipes)
            finally:pipes.close()
    def retain_unknown():
        try:base.save(out/'unknown-hold.json',{'protocol':'jev-linux-observer-unknown-v2','status':'UNKNOWN_HOLD','recoveryAccepted':False})
        except BaseException:pass
    try:
        args=[str(git),'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false']
        binding=base.checkout_binding(original(args+['rev-parse','--verify','HEAD'],'head',child_env=git_env),original(args+['rev-parse','--verify','HEAD^{tree}'],'tree',child_env=git_env),original(args+['status','--porcelain=v1','--untracked-files=all'],'clean',child_env=git_env),ctx['JEV_HEAD'])
        stage='WORKFLOW_BINDING'
        workflow=pin(checkout/'.github/workflows/ci.yml',CAP)
        control=canonical(original([str(node),str(root/'controls.mjs')],'controls'))
        need(control=={'protocol':'jev-linux-procfs-pure-controls-v1','passed':True,'cases':protocol['controlsPlan']['orderedNames'],'backendInvoked':False})
        stage='HEADER_DISCOVERY'
        hd=out/'headers';hd.mkdir(mode=0o700);header_receipt=headers(hd,min(deadline,time.monotonic()+20))
        build=out/'build';build.mkdir(mode=0o700);copy=build/'observer.c';write(copy,blobs['observer.c']);need(pin(copy,CAP)['sha256']==expected['observer.c'])
        artifact=build/'observer.node';flags=['-std=c11','-O2','-fPIC','-Wall','-Wextra','-Werror','-I',str(hd)]
        deps=dependency_paths(original([str(cc),*flags,'-M','-MT',str(artifact),str(copy)],'dependencies'),artifact)
        stage='DEPENDENCY_BINDING'
        need(copy.resolve() in deps and all((hd/n).resolve() in deps for n in header_receipt['selected']))
        selected=[]
        for p in deps:
            x=pin(p,1024*1024);selected.append({'pathSha256':hashlib.sha256(str(p).encode()).hexdigest(),'sha256':x['sha256'],'bytes':x['bytes']})
        # Closure discovery is same-job observed input, not certified compiler provenance.
        original([str(cc),*flags,'-shared',str(copy),'-o',str(artifact)],'compile',20)
        stage='ARTIFACT_BINDING'
        artifact_pin=pin(artifact,8388608)
        for p,x in zip(deps,selected):
            a=pin(p,1024*1024);need(a['sha256']==x['sha256'] and a['bytes']==x['bytes'])
        need(pin(cc)==tools['cc'])
        # No poll/wait/communicate: target identity remains unreaped throughout sample.
        stage='TARGET_START'
        target=subprocess.Popen([str(node),str(root/'target.mjs')],cwd=checkout,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True)
        target_custody=base.OriginalCustody(target);target_channel=OwnedChannel(target,out,'target');target_channel.open()
        stage='TARGET_READINESS'
        while target_channel.output()[0]!=b'READY\n':
            need(not interrupted[0] and time.monotonic()<=deadline and target_custody.observe()=='LIVE')
            need(not target_channel.pump(0.02));stdout,stderr=target_channel.output();need(not stderr and b'READY\n'.startswith(stdout))
        need(target_custody.observe()=='LIVE')
        class FencedChannel(OwnedChannel):
            def pump(self,seconds,persist=True):
                if persist:need(target_custody.observe()=='LIVE')
                return super().pump(seconds,persist)
        child_env={**env,'JEV_TARGET_PID':str(target.pid),'JEV_METADATA_DEP_SHA':BASE_METADATA_SHA,'JEV_ADDON_SHA':artifact_pin['sha256']}
        stage='OBSERVER_START'
        observer=subprocess.Popen([str(node),str(root/'observer.mjs'),str(artifact)],cwd=checkout,env=child_env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True)
        c=base.OriginalCustody(observer);channel=FencedChannel(observer,out,'observer')
        stage='OBSERVER_WAIT'
        try:raw,err,code=base.drive_original(c,channel,min(deadline,time.monotonic()+30),interrupted,retain_unknown)
        finally:channel.close()
        need(target_custody.observe()=='LIVE')
        stage='RESULT_VALIDATION'
        retain_receipt('observer',c,channel)
        result=decode_result(raw,code,err)
        if code==0:need(result['runId']==ctx['JEV_RUN_ID'] and result['runAttempt']==ctx['JEV_RUN_ATTEMPT'] and result['artifact']=={'sha256':artifact_pin['sha256'],'bytes':artifact_pin['bytes']})
        stage='TARGET_SETTLEMENT'
        target.stdin.close()
        stdout,stderr,tcode=base.drive_original(target_custody,target_channel,min(deadline,time.monotonic()+10),interrupted,retain_unknown)
        retain_receipt('target',target_custody,target_channel)
        need(tcode==0 and stdout==b'READY\n' and stderr==b'');target_channel.close()
        stage='SOURCE_RECHECK'
        for n,h in expected.items():need(source(root/n,h)==blobs[n])
        source(dep/'owner.py',BASE_OWNER_SHA);source(dep/'metadata.mjs',BASE_METADATA_SHA)
        for label,path in [('node',node),('git',git),('python',Path(sys.executable).resolve()),('cc',cc)]:need(pin(path)==tools[label])
        need(not interrupted[0] and time.monotonic()<=deadline)
        result['owner']={'protocol':'jev-linux-observer-owner-v2','checkout':binding,'workflow':workflow,'sourcesUnchanged':True,'tools':tools,
            'headers':header_receipt,'selectedDependencyCount':len(selected),'selectedDependenciesSha256':hashlib.sha256(json.dumps(selected,separators=(',',':')).encode()).hexdigest(),
            'sourceSha256':expected,'targetLiveUnreapedThroughObservation':True,'observerTerminalReapedEOF':c.reaped and channel.terminal_eof,
            'targetTerminalReapedEOF':target_custody.reaped,'targetExitCode':0,'observerExitCode':code,'signalsSent':target_custody.signals+c.signals,
            'platformRuntimeTrustRequired':True,'compilerDistributionQualified':False,'platformCredentials':'ACTIONS_PLATFORM_CREDENTIALS_NOT_ABSENT','originals':receipts,
            'globalGroupAbsenceClaimed':False,'deadlineReached':False,'interrupted':False,'hashBytes':budget}
        # source-only no-signal success; owner COMPLETE alone is never a native PASS.
        need(result['owner']['signalsSent']==0);stage='RESULT_RETENTION';base.save(out/'observer-result.json',result)
        print('LINUX_OBSERVER_COMPLETE' if code==0 else 'LINUX_OBSERVER_UNSUPPORTED');return code
    except BaseException:
        failed_stage=stage
        if observer is not None and (c is None or not c.reaped):
            if c is None:c=base.OriginalCustody(observer)
            if channel is None:channel=OwnedChannel(observer,out,'observer')
            try:base.drive_original(c,channel,time.monotonic()+CLEANUP_SECONDS,interrupted,retain_unknown)
            except BaseException:pass
        if target is not None and target_custody is None:target_custody=base.OriginalCustody(target)
        if target is not None and target_channel is None:target_channel=OwnedChannel(target,out,'target')
        if target_custody is not None and not target_custody.reaped:
            try:target.stdin.close()
            except BaseException:pass
            try:base.drive_original(target_custody,target_channel,time.monotonic()+CLEANUP_SECONDS,interrupted,retain_unknown)
            except BaseException:pass
        # drive_original retains original ownership until known direct settlement.
        for slot,custody,pipes in [('target',target_custody,target_channel),('observer',c,channel)]:
            if custody is not None and pipes is not None:
                try:retain_receipt(slot,custody,pipes)
                except BaseException:pass
        try:base.save(out/'observer-result.json',{'protocol':'jev-linux-procfs-observer-owner-refused-v2','status':'REFUSED','stage':failed_stage,'originals':receipts,'recoveryAccepted':False})
        except BaseException:pass
        print('LINUX_OBSERVER_OWNER_REFUSED',file=sys.stderr);return 2
    finally:
        for owned in (channel,target_channel):
            if owned is not None:
                try:owned.close()
                except BaseException:pass

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print('LINUX_OBSERVER_OWNER_REFUSED',file=sys.stderr);raise SystemExit(2)
