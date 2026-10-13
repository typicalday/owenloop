import importlib.util
import json
from types import SimpleNamespace
from pathlib import Path

# Future root-owned pure controls only; import performs no original execution.
spec = importlib.util.spec_from_file_location('owner', Path(__file__).with_name('owner.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
names = []
def test(name, fn):
    fn(); names.append(name)
def refused(fn):
    try:
        fn()
    except Exception:
        return
    raise AssertionError('FIXTURE_EXPECTED_REFUSAL')
def good():
    h='a'*64
    return {'protocol':'jev-linux-own-process-metadata-v2','status':'METADATA_COMPLETE',
      'context':{'repository':'typicalday/owenloop','pullRequest':369,'headSha256':h,'baseSha256':h,'runId':'123','runAttempt':'1','job':'linux-metadata-preflight','sameRepositoryHeadGate':True,'admissionKind':'MUTABLE_ROOT_SCHEDULING_CONTROL'},
      'platform':'LINUX','architecture':'X86_64','kernel':{'releaseSha256':h,'releaseBytes':10,'numericVersion':[6,12,0],'exactVersionRetained':False},
      'ownProcess':{'uid':{'fourEqual':True,'allNonzero':True},'gid':{'fourEqual':True,'allNonzero':True},'supplementaryGroupCount':2,'supplementaryGroupSetSha256':h,
        'capabilities':{k:'ZERO' for k in ['inheritable','permitted','effective','bounding','ambient']},'noNewPrivileges':False,'seccomp':'FILTER'},
      'procfs':{'filesystem':'PROCFS','hidepid':'NOT_DECLARED','subset':'NOT_DECLARED','ownPathFilesystemVerified':True,'readOnly':False,'optionsSha256':h},
      'namespaces':[{'kind':k,'identitySha256':h,'stableAcrossTwoReads':True} for k in ['pid','mnt','user']],
      'node':{'version':'22.23.0','napi':10,'sha256':h,'bytes':123,'provenance':'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},
      'sources':[{'slot':k,'sha256':h,'bytes':123} for k in ['metadata.mjs','owner.py','protocol.json']],
      'hashBudget':{'selectedFiles':4,'totalBytes':492},'platformCredentials':'ACTIONS_PLATFORM_CREDENTIALS_NOT_ABSENT',
      'compilerQualified':False,'targetAccessQualified':False,'threadEnumerationQualified':False,'nativeQualified':False,
      'runtimeAccepted':False,'laterObserverMustRemeasure':True,'continuousCoverageClaimed':False}
def raw(v): return (json.dumps(v,separators=(',',':'))+'\n').encode()
def positive(): assert m.decode(raw(good()),b'',0)==good()
def mutation(key,value):
    v=good(); v[key]=value; refused(lambda:m.decode(raw(v),b'',0))
test('OWNER_CANONICAL_METADATA',positive)
test('OWNER_NONZERO_CHILD_REFUSED',lambda:refused(lambda:m.decode(raw(good()),b'',2)))
test('OWNER_STDERR_REFUSED',lambda:refused(lambda:m.decode(raw(good()),b'PRIVATE',0)))
test('OWNER_TRUNCATED_REFUSED',lambda:refused(lambda:m.decode(raw(good())[:-2],b'',0)))
test('OWNER_UNKNOWN_KEY_REFUSED',lambda:mutation('rawIdentity','PRIVATE'))
test('OWNER_RUNTIME_PASS_REFUSED',lambda:mutation('runtimeAccepted',True))
test('OWNER_UNKNOWN_ARCH_REFUSED',lambda:mutation('architecture','PRIVATE'))
test('OWNER_BOOL_INTEGER_REFUSED',lambda:mutation('hashBudget',{'selectedFiles':True,'totalBytes':0}))
test('OWNER_DUPLICATE_KEY_REFUSED',lambda:refused(lambda:m.decode(raw(good()).replace(b'"status":',b'"status":"METADATA_COMPLETE","status":',1),b'',0)))
test('OWNER_INVALID_UTF8_REFUSED',lambda:refused(lambda:m.decode(b'\xff\n',b'',0)))
test('OWNER_STREAM_OVERFLOW_REFUSED',lambda:refused(lambda:m.decode(b'x'*65537,b'',0)))
test('OWNER_NONCANONICAL_REFUSED',lambda:refused(lambda:m.decode(json.dumps(good(),indent=2).encode()+b'\n',b'',0)))

class FakeProc:
    pid=17
    def __init__(self,fail_wait=False): self.waits=0; self.fail_wait=fail_wait
    def wait(self):
        self.waits+=1
        if self.fail_wait: raise RuntimeError('SYNTHETIC_WAIT_FAILURE')
        return 0
class FakeOps:
    P_PID=1; WEXITED=2; WNOHANG=4; WNOWAIT=8; CLD_EXITED=1; CLD_KILLED=2; CLD_DUMPED=3
    def __init__(self,states): self.states=list(states); self.last=self.states[-1]; self.sent=[]
    def waitid(self,*_):
        state=self.states.pop(0) if self.states else self.last
        if state=='LIVE': return None
        if state=='UNKNOWN': raise ChildProcessError('SYNTHETIC_UNKNOWN')
        return SimpleNamespace(si_pid=17,si_code=1)
    def getpgid(self,_): return 17
    def killpg(self,_p,sig): self.sent.append(sig)
class FakeChannel:
    def __init__(self,overflow=False,sink_failure=False): self.pumps=0; self.overflow=overflow; self.sink_failure=sink_failure
    def open(self): pass
    def pump(self,_seconds,persist=True):
        self.pumps+=1
        if self.sink_failure and self.pumps==1: raise OSError('SYNTHETIC_SINK')
        return self.overflow and self.pumps==1
    def eof(self): return self.pumps>=1
    def output(self): return b'FIXTURE\n',b''
class FakeClock:
    def __init__(self): self.value=0
    def monotonic(self): self.value+=1; return self.value
    def sleep(self,_): self.value+=1
def custody(states,fail_wait=False):
    proc=FakeProc(fail_wait); ops=FakeOps(states); return m.OriginalCustody(proc,ops),proc,ops
def live():
    c,p,o=custody(['LIVE']); assert c.observe()=='LIVE' and p.waits==0
def terminal():
    c,p,o=custody(['TERMINAL']); assert c.observe()=='TERMINAL_UNREAPED' and p.waits==0
def before_reap():
    c,p,o=custody(['LIVE']); c.send(15); assert len(o.sent)==1 and p.waits==0
def after_reap():
    c,p,o=custody(['TERMINAL']); c.finalize(True); refused(lambda:c.send(15)); assert not o.sent and p.waits==1
def unknown():
    c,p,o=custody(['UNKNOWN']); assert c.observe()=='UNKNOWN'; refused(lambda:c.send(15)); assert not o.sent and p.waits==0
def bad_wait():
    c,p,o=custody(['TERMINAL'],True); refused(lambda:c.finalize(True)); refused(lambda:c.send(15)); assert not o.sent and p.waits==1
def no_eof():
    c,p,o=custody(['TERMINAL']); refused(lambda:c.finalize(False)); assert p.waits==0
def drive(kind):
    states=['TERMINAL'] if kind=='SUCCESS' else (['UNKNOWN','TERMINAL'] if kind=='UNKNOWN' else ['LIVE','TERMINAL'])
    c,p,o=custody(states); ch=FakeChannel(kind=='OVERFLOW',kind=='SINK'); clock=FakeClock()
    fn=lambda:m.drive_original(c,ch,0 if kind=='DEADLINE' else 100,[kind=='INTERRUPTION'],lambda:None,clock)
    if kind=='SUCCESS': assert fn()==(b'FIXTURE\n',b'',0)
    else: refused(fn)
    assert c.reaped and p.waits==1
    if kind=='UNKNOWN': assert not o.sent
test('ORIGINAL_LIVE_UNREAPED',live)
test('ORIGINAL_TERMINAL_UNREAPED',terminal)
test('ORIGINAL_SIGNAL_BEFORE_REAP',before_reap)
test('ORIGINAL_SIGNAL_NEVER_AFTER_REAP',after_reap)
test('ORIGINAL_UNKNOWN_NO_SIGNAL',unknown)
test('ORIGINAL_WAIT_FAILURE_NO_SIGNAL',bad_wait)
test('ORIGINAL_EOF_REQUIRED',no_eof)
test('DRIVE_SUCCESS_DIRECT_SETTLEMENT',lambda:drive('SUCCESS'))
test('DRIVE_DEADLINE_REFUSED_SETTLED',lambda:drive('DEADLINE'))
test('DRIVE_INTERRUPTION_REFUSED_SETTLED',lambda:drive('INTERRUPTION'))
test('DRIVE_OVERFLOW_REFUSED_SETTLED',lambda:drive('OVERFLOW'))
test('DRIVE_UNKNOWN_NO_SIGNAL_SETTLED',lambda:drive('UNKNOWN'))
test('DRIVE_SINK_FAILURE_REFUSED_SETTLED',lambda:drive('SINK'))
def pipe_cap():
    b=bytearray(); assert m.append_capped(b,b'x'*65537) is True and len(b)==65536
test('PIPE_CAPTURE_HARD_CAP',pipe_cap)
def checkout_fixture(which):
    h='a'*40; t='b'*40
    head=(('c'*40 if which=='HEAD' else h)+'\n').encode()
    tree=(('PRIVATE' if which=='TREE' else t)+'\n').encode()
    status=b'PRIVATE_FILENAME' if which=='DIRTY' else b''
    fn=lambda:m.checkout_binding(head,tree,status,h)
    if which=='GOOD': assert fn()['tree']==t
    else: refused(fn)
test('CHECKOUT_HEAD_TREE_CLEAN',lambda:checkout_fixture('GOOD'))
test('CHECKOUT_WRONG_HEAD_REFUSED',lambda:checkout_fixture('HEAD'))
test('CHECKOUT_MALFORMED_TREE_REFUSED',lambda:checkout_fixture('TREE'))
test('CHECKOUT_MISSING_TREE_REFUSED',lambda:refused(lambda:m.checkout_binding(b'a'*40+b'\n',b'',b'','a'*40)))
test('CHECKOUT_DIRTY_REFUSED',lambda:checkout_fixture('DIRTY'))
test('SOURCE_MISMATCH_REFUSED',lambda:refused(lambda:m.source_binding({'owner.py':{'sha256':'a'*64}},{'owner.py':'b'*64})))
test('SOURCE_MISSING_REFUSED',lambda:refused(lambda:m.source_binding({}, {'owner.py':'a'*64})))
test('OWNER_RUN_CONTEXT_REFUSED',lambda:mutation('context',{**good()['context'],'runId':'PRIVATE'}))
test('OWNER_ATTEMPT_CONTEXT_REFUSED',lambda:mutation('context',{**good()['context'],'runAttempt':'0'}))
test('OWNER_JOB_CONTEXT_REFUSED',lambda:mutation('context',{**good()['context'],'job':'other'}))
test('GIT_NONZERO_REFUSED',lambda:refused(lambda:m.command_result(b'',b'',2)))
test('GIT_STDERR_REFUSED',lambda:refused(lambda:m.command_result(b'',b'PRIVATE',0)))
print(json.dumps({'protocol':'jev-linux-metadata-fixture-controls-python-v2','syntheticOnly':True,'backendUsed':False,
 'procfsRead':False,'subprocessUsed':False,'passed':len(names),'failed':0,'cases':names},separators=(',',':')))
