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
EVENT_INPUT_CAP=1048576
TOTAL_SECONDS=210
HASH_CAP=32*1024*1024
GIT_CAP=16*1024*1024
QUALIFICATION_MANIFEST='f601a6517143986f6d992bc54a671c447dff947036ef2724b1618812b7f933bb'
JOB='linux-one-relay-q2-qualification'
BASE='b4ead192326ba607558cd3bb7687209cbb7c8165'
REPOSITORY='typicalday/owenloop'
BRANCH='jev-routing-foundation-20261008'

# Passive fixed-only marker; diagnostics never replace the original refusal.
REFUSAL_STAGES=frozenset(('ENVIRONMENT', 'EVENT_CONTEXT', 'EVENT_DECODE', 'EVENT_READ', 'GIT_CLEAN', 'GIT_HEAD', 'GIT_TOOL', 'GIT_TREE', 'OUTPUT_INIT', 'PATH_BINDING', 'PLATFORM', 'QUALIFICATION', 'QUALIFICATION_ADMISSION', 'QUALIFICATION_RESULT', 'QUALIFICATION_TOOL', 'RESULT_RETENTION', 'RUN_CONTEXT', 'SOURCE_BINDING', 'SOURCE_CLEANUP', 'SOURCE_RECHECK'))
REFUSAL_STATE={'stage':'PLATFORM','eventBytes':None,'marked':False}
def emit_refusal(error):
    try:
        if REFUSAL_STATE['marked']:return
        REFUSAL_STATE['marked']=True
        stage=REFUSAL_STATE['stage']
        if stage not in REFUSAL_STAGES:stage='UNKNOWN'
        size=REFUSAL_STATE['eventBytes']
        if type(size) is not int or not 0<=size<=9223372036854775807:size=None
        code='ERROR'
        if type(error) is RuntimeError and BaseException.args.__get__(error)==('HOSTED_ONE_RELAY_Q2_REFUSED',):code='PREDICATE_REFUSED'
        raw=(json.dumps({'protocol':'jev-hosted-one-relay-q2-refusal-marker-v1','stage':stage,'refusalCode':code,'eventBytes':size},separators=(',',':'))+'\n').encode('ascii')
        if len(raw)<=256:sys.stderr.write(raw.decode('ascii'))
    except BaseException:pass

def need(value):
    if not value:raise RuntimeError('HOSTED_ONE_RELAY_Q2_REFUSED')
def shape(s):
    return tuple(getattr(s,k) for k in ['st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'])
def sha(v):
    need(type(v) is str and len(v)==64 and all(c in '0123456789abcdef' for c in v))
def commit(v):
    need(type(v) is str and len(v)==40 and all(c in '0123456789abcdef' for c in v))
def decode(raw,cap=CAP,canonical=False):
    need(0<len(raw)<=cap)
    def pairs(rows):
        d={}
        for k,v in rows:need(k not in d);d[k]=v
        return d
    value=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_constant=lambda _:need(False))
    if canonical:need((json.dumps(value,separators=(',',':'),ensure_ascii=False)+'\n').encode()==raw)
    return value

def main():
    REFUSAL_STATE.update({'stage':'PLATFORM','eventBytes':None,'marked':False})
    os.umask(0o077)
    need(sys.platform=='linux' and all(hasattr(os,k) for k in ['waitid','WNOWAIT','WEXITED','WNOHANG','P_PID']))
    deadline=time.monotonic()+TOTAL_SECONDS;hash_bytes=[0];held=[];receipts=[];active=None;out=None;stage='ENVIRONMENT';REFUSAL_STATE['stage']=stage;interrupted=[False]
    def interrupt(_s,_f):interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    def read(path,cap=CAP,event_input=False):
        need(time.monotonic()<deadline)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            a=os.fstat(fd)
            if event_input:REFUSAL_STATE['eventBytes']=a.st_size
            need(stat.S_ISREG(a.st_mode) and a.st_nlink==1 and 0<=a.st_size<=cap)
            chunks=[];count=0;h=hashlib.sha256()
            while True:
                need(time.monotonic()<deadline);raw=os.read(fd,65536)
                if not raw:break
                chunks.append(raw);count+=len(raw);hash_bytes[0]+=len(raw)
                need(count<=cap and hash_bytes[0]<=HASH_CAP);h.update(raw)
            need(count==a.st_size and shape(a)==shape(os.fstat(fd))==shape(path.lstat()))
            held.append((fd,path,a))
            return b''.join(chunks),{'sha256':h.hexdigest(),'bytes':count},fd
        except BaseException:os.close(fd);raise
    def save(path,value):
        raw=(json.dumps(value,separators=(',',':'),ensure_ascii=False)+'\n').encode();need(len(raw)<=CAP)
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            view=memoryview(raw)
            while view:n=os.write(fd,view);need(n>0);view=view[n:]
            os.fsync(fd)
        finally:os.close(fd)
    def close_inputs():
        failed=False
        while held:
            fd,_,_=held.pop()
            try:os.close(fd)
            except BaseException:failed=True
        return not failed
    def unknown():
        if out:
            try:save(out/'unknown-hold.json',{'protocol':'jev-hosted-one-relay-q2-unknown-v1','status':'UNKNOWN_HOLD','stage':stage,'slot':active['slot'] if active else 'UNKNOWN','qualified':False})
            except BaseException:pass
    def hold():
        while True:
            unknown()
            try:time.sleep(0.1)
            except BaseException:pass
    try:
        need(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_EVENT_NAME')=='pull_request')
        stage='PATH_BINDING';REFUSAL_STATE['stage']=stage
        workspace=Path(os.environ['GITHUB_WORKSPACE']).resolve();temp=Path(os.environ['RUNNER_TEMP']).resolve()
        need(workspace.is_dir() and temp.is_dir())
        root=Path(__file__).resolve().parent;packet=root.parent/'linux-one-relay-q2'
        need(root==workspace/'.dev/one-relay-q2-hosted' and not packet.is_symlink())
        stage='EVENT_READ';REFUSAL_STATE['stage']=stage
        event_raw,_,_=read(Path(os.environ['GITHUB_EVENT_PATH']),EVENT_INPUT_CAP,event_input=True)
        stage='EVENT_DECODE';REFUSAL_STATE['stage']=stage
        event=decode(event_raw,EVENT_INPUT_CAP);pr=event['pull_request']
        stage='EVENT_CONTEXT';REFUSAL_STATE['stage']=stage
        need(event['action']=='synchronize' and type(event['number']) is int and event['number']==369 and pr['number']==369)
        need(event['repository']['full_name']==REPOSITORY and pr['head']['repo']['full_name']==REPOSITORY)
        need(pr['head']['ref']==BRANCH and pr['base']['sha']==BASE)
        head=pr['head']['sha'];commit(head);commit(os.environ['GITHUB_SHA'])
        stage='RUN_CONTEXT';REFUSAL_STATE['stage']=stage
        need(os.environ['GITHUB_REPOSITORY']==REPOSITORY and os.environ['GITHUB_JOB']==JOB)
        need(os.environ.get('JEV_ADMITTED_HEAD')==head and os.environ.get('JEV_OLD_PREFLIGHT_HEAD')=='' and os.environ.get('JEV_OLD_OBSERVER_HEAD')=='' and os.environ.get('JEV_OLD_DESCRIPTOR_HEAD')=='' and os.environ.get('JEV_OLD_ONE_RELAY_HEAD')=='')
        for key,limit in [('GITHUB_RUN_ID',20),('GITHUB_RUN_ATTEMPT',6)]:
            v=os.environ[key];need(v.isascii() and v.isdigit() and 1<=len(v)<=limit and not v.startswith('0'))
        context={'repository':REPOSITORY,'head':head,'base':BASE,'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'job':JOB}
        platform={'repository':REPOSITORY,'pullRequest':369,'event':'pull_request','action':'synchronize','branch':BRANCH,'head':head,'base':BASE,'workflowMergeSha':os.environ['GITHUB_SHA'],'runId':context['runId'],'runAttempt':context['runAttempt'],'job':JOB,'rootSchedulingGate':True,'globalOneShotGuaranteed':False,'rootExternalSelectedRunComparisonRequired':True}
        stage='OUTPUT_INIT';REFUSAL_STATE['stage']=stage
        out=temp/'jev-linux-one-relay-q2-qualification';out.mkdir(mode=0o700)
        control=out/'control';control.mkdir(mode=0o700)
        stage='SOURCE_BINDING';REFUSAL_STATE['stage']=stage
        bootstrap_raw,bootstrap_pin,_=read(Path(__file__).resolve());expected=os.environ['JEV_EXPECTED_BOOTSTRAP_SHA'];sha(expected);need(bootstrap_pin['sha256']==expected)
        manifest_raw,manifest_pin,_=read(packet/'manifest.json');need(manifest_pin['sha256']==QUALIFICATION_MANIFEST);manifest=decode(manifest_raw)
        source_pins={};blobs={}
        for row in manifest['files']:
            rel=row['relative'];need(type(rel) is str and not Path(rel).is_absolute() and '..' not in Path(rel).parts)
            raw,pin,_=read(packet/rel,262144);need(pin=={'sha256':row['sha256'],'bytes':row['bytes']});source_pins[rel]=pin;blobs[rel]=raw
        # The qualification manifest describes private600 source. Git100644 changes metadata only.
        source_pins['manifest.json']=manifest_pin
        workflow_raw,workflow_pin,_=read(workspace/'.github/workflows/ci.yml')
        ns={'__name__':'jev_hosted_custody','__file__':str(packet/'dependencies/owner.py')}
        exec(compile(blobs['dependencies/owner.py'],ns['__file__'],'exec'),ns);base=types.SimpleNamespace(**ns)
        class ClosingChannel(base.PipeChannel):
            def __init__(self,*args):
                super().__init__(*args);self.closed=False
            def close(self):
                if self.closed:return
                self.closed=True;failed=False
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
        stage='GIT_TOOL';REFUSAL_STATE['stage']=stage;git=Path(os.environ['JEV_GIT_EXECUTABLE']).resolve();need(git.is_absolute())
        _,git_pin,gitfd=read(git,GIT_CAP)
        clean_env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
        git_prefix=[str(git),'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false','-c','safe.directory='+str(workspace)]
        def original(slot,args):
            nonlocal active
            need(not interrupted[0] and time.monotonic()<deadline)
            proc=subprocess.Popen(git_prefix+args,executable='/proc/self/fd/'+str(gitfd),cwd=workspace,env=clean_env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True,pass_fds=(gitfd,))
            active={'proc':proc,'slot':slot};c=None;channel=None
            try:
                c=base.OriginalCustody(proc);channel=ClosingChannel(proc,control,slot)
                try:raw,err,code=base.drive_original(c,channel,min(deadline,time.monotonic()+10),interrupted,unknown)
                finally:
                    if not c.reaped:hold()
                    stdout,stderr=channel.output();eof=channel.eof()
                    receipts.append({'slot':slot,'directOriginalTerminal':True,'directOriginalReaped':True,'ownedPipesEOF':eof,'exitCode':proc.returncode,'signalsSent':c.signals,'stdoutBytes':len(stdout),'stdoutSha256':hashlib.sha256(stdout).hexdigest(),'stderrBytes':len(stderr),'stderrSha256':hashlib.sha256(stderr).hexdigest(),'globalGroupAbsenceClaimed':False})
                    try:channel.close()
                    finally:active=None
                need(code==0 and err==b'' and c.signals==0 and eof and not interrupted[0] and time.monotonic()<deadline)
                return raw
            except BaseException:
                if active:hold()
                raise
        stage='GIT_HEAD';REFUSAL_STATE['stage']=stage;head_raw=original('head',['rev-parse','--verify','HEAD'])
        stage='GIT_TREE';REFUSAL_STATE['stage']=stage;tree_raw=original('tree',['rev-parse','--verify','HEAD^{tree}'])
        stage='GIT_CLEAN';REFUSAL_STATE['stage']=stage;status_raw=original('clean',['status','--porcelain=v1','--untracked-files=normal'])
        checkout=base.checkout_binding(head_raw,tree_raw,status_raw,head)
        stage='QUALIFICATION_ADMISSION';REFUSAL_STATE['stage']=stage
        node=Path(os.environ['JEV_NODE_EXECUTABLE']).resolve();cc=Path('/usr/bin/cc').resolve();need(node.is_file() and cc.is_file())
        admission={'protocol':'jev-one-relay-q2-qualification-admission-v1','executionAdmitted':True,'scope':'HARMLESS_ONE_RELAY_Q2_ONLY','sourceManifestSha256':QUALIFICATION_MANIFEST,'context':context,'tools':{'node':str(node),'cc':str(cc)},'outputParent':str(out),'outputName':'jev-one-relay-q2-qualification-payload'}
        admission_path=control/'admission.json';save(admission_path,admission)
        stage='QUALIFICATION_TOOL';REFUSAL_STATE['stage']=stage
        python=Path(sys.executable).resolve();_,python_pin,pythonfd=read(python,GIT_CAP)
        launch_raw,launch_pin,launchfd=read(packet/'launch.py');need(launch_raw==blobs['launch.py'])
        stage='QUALIFICATION';REFUSAL_STATE['stage']=stage
        # Separate original: inner signal handlers cannot overwrite parent interruption.
        proc=subprocess.Popen([str(python),'-B','-I','-S','/proc/self/fd/'+str(launchfd),str(admission_path)],executable='/proc/self/fd/'+str(pythonfd),cwd=workspace,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True,pass_fds=(pythonfd,launchfd))
        active={'proc':proc,'slot':'qualification-launch'};custody=None;channel=None;child_failed=False
        try:
            custody=base.OriginalCustody(proc);channel=ClosingChannel(proc,control,'qualification-launch');channel.open()
            need(os.getpgid(proc.pid)==custody.pgid)
            child_deadline=min(deadline,time.monotonic()+165)
            try:
                while True:
                    need(not interrupted[0] and time.monotonic()<child_deadline)
                    state=custody.observe();need(state!='UNKNOWN');need(not channel.pump(0.02))
                    if state=='TERMINAL_UNREAPED' and channel.eof():break
                code=custody.finalize(True)
                need(not interrupted[0] and time.monotonic()<child_deadline)
            except BaseException:
                child_failed=True;cleanup_end=time.monotonic()+10
                state=custody.observe()
                # No SIGKILL of an owner that may retain separately owned originals.
                if not custody.reap_attempted and not custody.uncertain and state=='LIVE':
                    try:custody.send(signal.SIGTERM)
                    except BaseException:pass
                while not custody.reaped:
                    if time.monotonic()>=cleanup_end:unknown()
                    state=custody.observe()
                    try:channel.pump(0.02,False)
                    except BaseException:custody.uncertain=True
                    if state=='TERMINAL_UNREAPED' and channel.eof():
                        try:code=custody.finalize(True)
                        except BaseException:pass
                    if not custody.reaped:
                        try:time.sleep(0.1)
                        except BaseException:pass
            stdout,stderr=channel.output();eof=channel.eof()
            receipts.append({'slot':'qualification-launch','directOriginalTerminal':True,'directOriginalReaped':custody.reaped,'ownedPipesEOF':eof,'exitCode':proc.returncode,'signalsSent':custody.signals,'stdoutBytes':len(stdout),'stdoutSha256':hashlib.sha256(stdout).hexdigest(),'stderrBytes':len(stderr),'stderrSha256':hashlib.sha256(stderr).hexdigest(),'globalGroupAbsenceClaimed':False})
            channel.close();active=None
            need(not child_failed and custody.reaped and eof and custody.signals==0 and not interrupted[0] and time.monotonic()<deadline and code in [0,2])
        except BaseException:
            if active:
                if custody is None or channel is None or not custody.reaped:hold()
                try:channel.close()
                finally:active=None
            raise
        stage='QUALIFICATION_RESULT';REFUSAL_STATE['stage']=stage
        raw,inner_pin,_=read(out/admission['outputName']/'result.json');inner=decode(raw,canonical=True)
        need(inner['protocol']=='jev-one-relay-q2-qualification-result-v1')
        need((code==0 and stdout==b'JEV_ONE_RELAY_Q2_COMPLETE\n' and stderr==b'' and inner['status']=='SUPPORTED') or (code==2 and inner['status'] in ['REFUSED','UNSUPPORTED']))
        stage='SOURCE_RECHECK';REFUSAL_STATE['stage']=stage
        need([r['slot'] for r in receipts]==['head','tree','clean','qualification-launch'])
        if code==0:need(all(r['directOriginalTerminal'] is True and r['directOriginalReaped'] is True and r['ownedPipesEOF'] is True and type(r['exitCode']) is int and r['exitCode']==0 and r['signalsSent']==0 for r in receipts))
        for fd,path,before in held:need(shape(before)==shape(os.fstat(fd))==shape(path.lstat()))
        need(not interrupted[0] and time.monotonic()<deadline)
        stage='SOURCE_CLEANUP';REFUSAL_STATE['stage']=stage;need(close_inputs())
        stage='RESULT_RETENTION';REFUSAL_STATE['stage']=stage
        result={'protocol':'jev-hosted-one-relay-q2-result-v1','status':'SUPPORTED' if code==0 else 'REFUSED','stage':stage,'context':platform,'checkout':checkout,'qualification':inner,'qualificationResultPin':inner_pin,'publicationSourcePins':source_pins,'bootstrap':bootstrap_pin,'workflow':workflow_pin,'git':{**git_pin,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},'launchPython':{**python_pin,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},'verifiedLaunch':launch_pin,'preflightOriginals':receipts,'bootstrapHashBytes':hash_bytes[0],'platformFirstEntryTrustRequired':True,'compilerDistributionQualified':False,'providerAccessQualified':False,'recoveryAccepted':False,'globalGroupAbsenceClaimed':False,'rootActualAuditRequired':True}
        save(out/'result.json',result)
        need(not interrupted[0] and time.monotonic()<deadline)
        if code==0:print('JEV_HOSTED_ONE_RELAY_Q2_COMPLETE')
        else:print('JEV_HOSTED_ONE_RELAY_Q2_REFUSED',file=sys.stderr)
        return code
    except BaseException as error:
        emit_refusal(error)
        if active:hold()
        if not close_inputs():stage='SOURCE_CLEANUP'
        if out:
            try:save(out/'result.json',{'protocol':'jev-hosted-one-relay-q2-result-v1','status':'REFUSED','stage':stage,'preflightOriginals':receipts,'deadlineReached':time.monotonic()>=deadline,'interrupted':interrupted[0],'qualified':False,'providerAccessQualified':False,'recoveryAccepted':False,'globalGroupAbsenceClaimed':False})
            except BaseException:pass
        print('JEV_HOSTED_ONE_RELAY_Q2_REFUSED',file=sys.stderr);return 2
    finally:
        if not close_inputs():raise RuntimeError('HOSTED_ONE_RELAY_Q2_REFUSED')

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        emit_refusal(error)
        print('JEV_HOSTED_ONE_RELAY_Q2_REFUSED',file=sys.stderr);raise SystemExit(2)
