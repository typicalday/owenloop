import hashlib
import json
import os
from pathlib import Path
import signal
import selectors
import stat
import subprocess
import sys
import time

CAP = 65536
CAP_SECONDS = 60
CLEANUP_SECONDS = 10

def need(value):
    if not value:
        raise RuntimeError('PREFLIGHT_REFUSED')

def context(env):
    expected = {'JEV_REPOSITORY': 'typicalday/owenloop', 'JEV_PR': '369',
                'JEV_BRANCH': 'jev-routing-foundation-20261008', 'JEV_EVENT': 'pull_request', 'JEV_ACTION': 'synchronize',
                'JEV_HEAD_REPOSITORY': 'typicalday/owenloop',
                'JEV_BASE': 'b4ead192326ba607558cd3bb7687209cbb7c8165', 'JEV_JOB': 'linux-metadata-preflight'}
    need(all(env.get(k) == v for k, v in expected.items()))
    head = env.get('JEV_HEAD', '')
    need(len(head) == 40 and all(c in '0123456789abcdef' for c in head))
    need(head == env.get('JEV_ADMITTED_HEAD'))
    need(env.get('JEV_RUN_ID','').isascii() and env.get('JEV_RUN_ID','').isdigit() and 1 <= len(env['JEV_RUN_ID']) <= 20 and not env['JEV_RUN_ID'].startswith('0'))
    need(env.get('JEV_RUN_ATTEMPT','').isascii() and env.get('JEV_RUN_ATTEMPT','').isdigit() and 1 <= len(env['JEV_RUN_ATTEMPT']) <= 6 and not env['JEV_RUN_ATTEMPT'].startswith('0'))
    for k in ('OWNER','METADATA','PROTOCOL'):
        v=env.get('JEV_EXPECTED_'+k+'_SHA','')
        need(len(v)==64 and all(c in '0123456789abcdef' for c in v))
    return {**expected, 'JEV_HEAD':head, 'JEV_ADMITTED_HEAD':head, 'JEV_RUN_ID':env['JEV_RUN_ID'], 'JEV_RUN_ATTEMPT':env['JEV_RUN_ATTEMPT']}

def decode(stdout, stderr, returncode):
    need(returncode == 0 and stderr == b'' and 0 < len(stdout) <= CAP)
    text = stdout.decode('utf-8', errors='strict')
    need(text.endswith('\n') and not text.endswith('\n\n'))
    def pairs(rows):
        d = {}
        for k, v in rows:
            need(k not in d); d[k] = v
        return d
    value = json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: need(False))
    need(type(value) is dict and value.get('protocol') == 'jev-linux-own-process-metadata-v2')
    need(value.get('status') == 'METADATA_COMPLETE')
    need(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n' == text)
    def keys(v, names):
        need(type(v) is dict and set(v) == set(names))
    def boolean(v):
        need(type(v) is bool)
    def integer(v, maximum):
        need(type(v) is int and 0 <= v <= maximum)
    def sha(v):
        need(type(v) is str and len(v) == 64 and all(c in '0123456789abcdef' for c in v))
    def pin(v, maximum):
        keys(v, ['sha256','bytes']); sha(v['sha256']); integer(v['bytes'], maximum)
    keys(value, ['protocol','status','context','platform','architecture','kernel','ownProcess','procfs','namespaces',
        'node','sources','hashBudget','platformCredentials','compilerQualified','targetAccessQualified',
        'threadEnumerationQualified','nativeQualified','runtimeAccepted','laterObserverMustRemeasure','continuousCoverageClaimed'])
    c = value['context']; keys(c, ['repository','pullRequest','headSha256','baseSha256','runId','runAttempt','job','sameRepositoryHeadGate','admissionKind'])
    need(c['repository'] == 'typicalday/owenloop' and type(c['pullRequest']) is int and c['pullRequest'] == 369)
    sha(c['headSha256']); sha(c['baseSha256']); need(c['job']=='linux-metadata-preflight')
    for k,cap in [('runId',20),('runAttempt',6)]: need(type(c[k]) is str and c[k].isascii() and c[k].isdigit() and 1<=len(c[k])<=cap and not c[k].startswith('0'))
    need(c['sameRepositoryHeadGate'] is True and c['admissionKind'] == 'MUTABLE_ROOT_SCHEDULING_CONTROL')
    need(value['platform'] == 'LINUX' and value['architecture'] in ('X86_64','ARM64'))
    k = value['kernel']; keys(k, ['releaseSha256','releaseBytes','numericVersion','exactVersionRetained'])
    sha(k['releaseSha256']); integer(k['releaseBytes'], 256); need(k['releaseBytes'] > 0 and k['exactVersionRetained'] is False)
    need(type(k['numericVersion']) is list and len(k['numericVersion']) == 3)
    for v in k['numericVersion']: integer(v,99999)
    p = value['ownProcess']; keys(p, ['uid','gid','supplementaryGroupCount','supplementaryGroupSetSha256','capabilities','noNewPrivileges','seccomp'])
    for label in ('uid','gid'):
        keys(p[label], ['fourEqual','allNonzero'])
        for b in p[label].values(): boolean(b)
    integer(p['supplementaryGroupCount'],64); sha(p['supplementaryGroupSetSha256'])
    keys(p['capabilities'], ['inheritable','permitted','effective','bounding','ambient'])
    need(all(v in ('ZERO','NONZERO') for v in p['capabilities'].values()))
    boolean(p['noNewPrivileges']); need(p['seccomp'] in ('DISABLED','STRICT','FILTER'))
    f = value['procfs']; keys(f, ['filesystem','hidepid','subset','readOnly','optionsSha256','ownPathFilesystemVerified'])
    need(f['filesystem'] == 'PROCFS' and f['hidepid'] in ('NOT_DECLARED','0','1','2','4'))
    boolean(f['readOnly']); sha(f['optionsSha256']); need(f['subset'] in ('PID','NOT_DECLARED') and f['ownPathFilesystemVerified'] is True)
    need(type(value['namespaces']) is list and len(value['namespaces']) == 3)
    for n, label in zip(value['namespaces'], ('pid','mnt','user')):
        keys(n, ['kind','identitySha256','stableAcrossTwoReads'])
        need(n['kind'] == label and n['stableAcrossTwoReads'] is True); sha(n['identitySha256'])
    n = value['node']; keys(n, ['version','napi','sha256','bytes','provenance'])
    need(n['version'] == '22.23.0' and type(n['napi']) is int and n['napi'] == 10)
    sha(n['sha256']); integer(n['bytes'],512*1024*1024)
    need(n['provenance'] == 'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION')
    need(type(value['sources']) is list and len(value['sources']) == 3)
    for s, label in zip(value['sources'], ('metadata.mjs','owner.py','protocol.json')):
        keys(s, ['slot','sha256','bytes']); need(s['slot'] == label)
        pin({'sha256':s['sha256'],'bytes':s['bytes']},CAP)
    keys(value['hashBudget'], ['selectedFiles','totalBytes'])
    integer(value['hashBudget']['selectedFiles'],64); integer(value['hashBudget']['totalBytes'],1024*1024*1024)
    need(value['hashBudget']['selectedFiles'] == 4)
    need(value['hashBudget']['totalBytes'] == n['bytes'] + sum(s['bytes'] for s in value['sources']))
    need(value['platformCredentials'] == 'ACTIONS_PLATFORM_CREDENTIALS_NOT_ABSENT')
    for k in ['nativeQualified','runtimeAccepted','targetAccessQualified','threadEnumerationQualified','compilerQualified','continuousCoverageClaimed']:
        need(value.get(k) is False)
    need(value.get('laterObserverMustRemeasure') is True)
    return value

def tool_hash(path, deadline, previous_bytes, cap=512*1024*1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        a = os.fstat(fd)
        need(stat.S_ISREG(a.st_mode) and 0 <= a.st_size <= cap)
        h = hashlib.sha256(); count = 0
        while True:
            need(time.monotonic() <= deadline)
            raw = os.read(fd, 65536)
            if not raw:
                break
            count += len(raw)
            need(count <= cap and previous_bytes + count <= 1024 * 1024 * 1024)
            h.update(raw)
        b = os.fstat(fd)
        final_path=os.stat(path,follow_symlinks=False)
        for k in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'):
            need(getattr(a,k) == getattr(b,k) == getattr(final_path,k))
        need(count == a.st_size)
        return {'sha256': h.hexdigest(), 'bytes': count,
                'provenance': 'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'}
    finally:
        os.close(fd)

def save(path, value):
    raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    need(len(raw) <= CAP)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    except BaseException:
        raise

class OriginalCustody:
    def __init__(self, proc, ops=os):
        self.proc=proc; self.ops=ops; self.pgid=proc.pid
        self.reap_attempted=False; self.reaped=False; self.uncertain=False; self.signals=0

    def observe(self):
        if self.reap_attempted:
            return 'REAPED' if self.reaped else 'UNKNOWN'
        try:
            r=self.ops.waitid(self.ops.P_PID,self.proc.pid,self.ops.WEXITED|self.ops.WNOHANG|self.ops.WNOWAIT)
            if r is None:
                return 'LIVE'
            if r.si_pid==self.proc.pid and r.si_code in (self.ops.CLD_EXITED,self.ops.CLD_KILLED,self.ops.CLD_DUMPED):
                return 'TERMINAL_UNREAPED'
        except BaseException:
            pass
        self.uncertain=True
        return 'UNKNOWN'

    def send(self, sig):
        # A Popen value alone is never post-reap numeric authority.
        need(not self.reap_attempted and not self.uncertain)
        need(self.observe() in ('LIVE','TERMINAL_UNREAPED') and not self.uncertain)
        try:
            need(self.ops.getpgid(self.proc.pid)==self.pgid)
            self.ops.killpg(self.pgid,sig); self.signals+=1
        except BaseException:
            self.uncertain=True
            raise RuntimeError('PREFLIGHT_REFUSED')

    def finalize(self, eof):
        need(eof and self.observe()=='TERMINAL_UNREAPED')
        self.reap_attempted=True  # Disables all signals, including failed/uncertain wait.
        code=self.proc.wait()
        self.reaped=True
        return code

def append_capped(buffer, raw, cap=CAP):
    room=max(0,cap-len(buffer))
    buffer.extend(raw[:room])
    return len(raw)>room

def checkout_binding(head_raw, tree_raw, status_raw, admitted):
    need(head_raw==admitted.encode()+b'\n' and status_raw==b'')
    tree=tree_raw.decode('ascii',errors='strict').removesuffix('\n')
    need(tree_raw==tree.encode()+b'\n' and len(tree)==40 and all(c in '0123456789abcdef' for c in tree))
    return {'head':admitted,'tree':tree,'clean':True,'treeKind':'GIT_OBSERVATION_ROOT_COMPARISON_REQUIRED'}

def source_binding(actual, expected):
    need(set(actual)==set(expected) and all(actual[k]['sha256']==expected[k] for k in expected))

def command_result(stdout,stderr,code):
    need(code==0 and stderr==b'')
    return stdout

class PipeChannel:
    def __init__(self,proc,outdir,slot):
        self.proc=proc; self.outdir=outdir; self.slot=slot
        self.buffers={'stdout':bytearray(),'stderr':bytearray()}
        self.selector=None; self.fds={}; self.opened=False
    def open(self):
        self.selector=selectors.DefaultSelector()
        for name,stream in [('stdout',self.proc.stdout),('stderr',self.proc.stderr)]:
            os.set_blocking(stream.fileno(),False)
        for name,stream in [('stdout',self.proc.stdout),('stderr',self.proc.stderr)]:
            self.selector.register(stream,selectors.EVENT_READ,name)
        self.opened=True
        for name in ('stdout','stderr'):
            self.fds[name]=os.open(self.outdir/(self.slot+'.'+name),os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    def eof(self):
        return self.selector is not None and self.opened and not self.selector.get_map()
    def pump(self,seconds,persist=True):
        need(self.opened)
        overflow=False
        for key,_ in self.selector.select(seconds):
            try: raw=os.read(key.fd,8192)
            except BlockingIOError: continue
            if not raw:
                self.selector.unregister(key.fileobj); continue
            name=key.data; overflow=append_capped(self.buffers[name],raw) or overflow
            if persist:
                fd=self.fds[name]; os.lseek(fd,0,0)
                rawout=memoryview(self.buffers[name])
                while rawout:
                    written=os.write(fd,rawout); need(written>0); rawout=rawout[written:]
                os.ftruncate(fd,len(self.buffers[name]))
        return overflow
    def output(self):
        return bytes(self.buffers['stdout']),bytes(self.buffers['stderr'])
    def close(self):
        if self.selector is not None: self.selector.close()
        for stream in (self.proc.stdout,self.proc.stderr): stream.close()
        for fd in self.fds.values(): os.close(fd)

def drive_original(c,channel,deadline,interrupted,retain_unknown,clock=time):
    # Shared pure-test boundary: original/syscalls, pipe channel and clock injectable.
    try:
        channel.open()
        need(c.ops.getpgid(c.proc.pid)==c.pgid)
        while True:
            need(not interrupted[0] and clock.monotonic()<=deadline)
            state=c.observe(); need(state!='UNKNOWN')
            need(not channel.pump(0.02))
            if state=='TERMINAL_UNREAPED' and channel.eof(): break
        code=c.finalize(True)
        need(not interrupted[0] and clock.monotonic()<=deadline)
        stdout,stderr=channel.output()
        return stdout,stderr,code
    except BaseException:
        end=clock.monotonic()+CLEANUP_SECONDS; sent_term=False; sent_kill=False
        while clock.monotonic()<end:
            state=c.observe()
            if state=='REAPED': break
            if not c.uncertain and not c.reap_attempted:
                sig=None
                if not sent_term: sig=signal.SIGTERM; sent_term=True
                elif not sent_kill and clock.monotonic()>=end-5: sig=signal.SIGKILL; sent_kill=True
                if sig is not None:
                    try: c.send(sig)
                    except BaseException: pass
            try: channel.pump(0.02,False)
            except BaseException: c.uncertain=True
            if state=='TERMINAL_UNREAPED' and channel.eof():
                try: c.finalize(True); break
                except BaseException: c.uncertain=True
        while not c.reaped:
            try: retain_unknown()
            except BaseException: pass
            state=c.observe()
            try: channel.pump(0.02,False)
            except BaseException: pass
            if state=='TERMINAL_UNREAPED' and channel.eof():
                try: c.finalize(True)
                except BaseException: pass
            try: clock.sleep(0.1)
            except BaseException: pass
        raise RuntimeError('PREFLIGHT_REFUSED')

def run_original(argv,cwd,env,outdir,slot,deadline,interrupted):
    proc=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,close_fds=True)
    c=OriginalCustody(proc)
    channel=PipeChannel(proc,outdir,slot)
    def retain_unknown():
        save(outdir/'unknown-hold.json',{'protocol':'jev-linux-metadata-unknown-v2','status':'UNKNOWN_HOLD','runtimeAccepted':False})
    try:
        stdout,stderr,code=drive_original(c,channel,deadline,interrupted,retain_unknown)
        return stdout,stderr,code,{'slot':slot,'directOriginalTerminal':True,'directOriginalReaped':True,
            'ownedPipesEOF':True,'signalsSent':c.signals,'globalGroupAbsenceClaimed':False,'exitCode':code,
            'stdoutBytes':len(stdout),'stdoutSha256':hashlib.sha256(stdout).hexdigest(),
            'stderrBytes':len(stderr),'stderrSha256':hashlib.sha256(stderr).hexdigest()}
    finally:
        # drive_original never releases an unsettled or uncertain original.
        channel.close()

def main():
    os.umask(0o077)
    need(sys.platform=='linux' and len(sys.argv)==1)
    need(all(hasattr(os,k) for k in ('waitid','WNOWAIT','WEXITED','WNOHANG','P_PID')))
    ctx=context(os.environ)
    root=Path(__file__).resolve().parent
    need(root.name=='linux-metadata' and root.parent.name=='.dev')
    checkout=root.parent.parent
    tmp=Path(os.environ.get('RUNNER_TEMP','')); need(tmp.is_absolute() and tmp.is_dir() and not tmp.is_symlink())
    outdir=tmp/'jev-linux-metadata-preflight-v2'; outdir.mkdir(mode=0o700)
    output=outdir/'metadata-result.json'
    node=Path(os.environ.get('JEV_NODE_EXECUTABLE','')); git=Path(os.environ.get('JEV_GIT_EXECUTABLE',''))
    for path in (node,git): need(path.is_absolute() and stat.S_ISREG(path.lstat().st_mode))
    interrupted=[False]
    def interrupt(_s,_f): interrupted[0]=True
    signal.signal(signal.SIGTERM,interrupt); signal.signal(signal.SIGINT,interrupt)
    deadline=time.monotonic()+CAP_SECONDS; budget=0; tools={}; receipts=[]
    env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','TZ':'UTC',**ctx}
    git_env={**env,'GIT_OPTIONAL_LOCKS':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
    try:
        for label,path in [('node',node),('git',git),('python',Path(sys.executable).resolve())]:
            tools[label]=tool_hash(path,deadline,budget); budget+=tools[label]['bytes']
        expected={f:os.environ['JEV_EXPECTED_'+label+'_SHA'] for f,label in [('owner.py','OWNER'),('metadata.mjs','METADATA'),('protocol.json','PROTOCOL')]}
        def sources():
            nonlocal budget
            result={}
            for f in expected:
                x=tool_hash(root/f,deadline,budget,CAP); budget+=x['bytes']; result[f]=x
            return result
        before=sources(); source_binding(before,expected)
        args=[str(git),'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false']
        results=[]
        for slot,cmd in [('git-head',['rev-parse','--verify','HEAD']),('git-tree',['rev-parse','--verify','HEAD^{tree}']),('git-clean',['status','--porcelain=v1','--untracked-files=all'])]:
            stdout,stderr,code,receipt=run_original(args+cmd,checkout,git_env,outdir,slot,deadline,interrupted)
            results.append(command_result(stdout,stderr,code)); receipts.append(receipt)
        binding=checkout_binding(*results,ctx['JEV_HEAD'])
        workflow=tool_hash(checkout/'.github/workflows/ci.yml',deadline,budget,CAP)
        budget+=workflow['bytes']
        stdout,stderr,code,receipt=run_original([str(node),str(root/'metadata.mjs')],root,env,outdir,'metadata',deadline,interrupted)
        result=decode(stdout,stderr,code); receipts.append(receipt)
        need(result['node']['sha256']==tools['node']['sha256'] and result['node']['bytes']==tools['node']['bytes'])
        for s in result['sources']:
            need(s['sha256']==before[s['slot']]['sha256'] and s['bytes']==before[s['slot']]['bytes'])
        need(result['context']['headSha256']==hashlib.sha256(ctx['JEV_HEAD'].encode()).hexdigest())
        need(result['context']['baseSha256']==hashlib.sha256(ctx['JEV_BASE'].encode()).hexdigest())
        need(result['context']['runId']==ctx['JEV_RUN_ID'] and result['context']['runAttempt']==ctx['JEV_RUN_ATTEMPT'])
        after=sources(); source_binding(after,expected); need(before==after)
        budget+=result['hashBudget']['totalBytes']; need(budget<=1024*1024*1024)
        need(not interrupted[0] and time.monotonic()<=deadline)
        result['owner']={'protocol':'jev-linux-metadata-owner-v2','originals':receipts,'checkout':binding,
            'workflow':workflow,'sourceEquality':True,'sourcePins':after,'tools':tools,
            'runId':ctx['JEV_RUN_ID'],'runAttempt':ctx['JEV_RUN_ATTEMPT'],'job':'linux-metadata-preflight',
            'globalGroupAbsenceClaimed':False,'hashBudget':{'selectedReads':14,'totalBytes':budget},
            'deadlineReached':False,'interrupted':False,'platformRuntimeTrustRequired':True,
            'stdoutSha256':hashlib.sha256(stdout).hexdigest(),'stdoutBytes':len(stdout),'stderrBytes':len(stderr)}
        save(output,result)
        need(not interrupted[0] and time.monotonic()<=deadline)
        print('LINUX_METADATA_COMPLETE'); return 0
    except BaseException:
        try: save(output,{'protocol':'jev-linux-metadata-refusal-v2','status':'REFUSED','runtimeAccepted':False,'nativeQualified':False})
        except BaseException: pass
        print('LINUX_METADATA_OWNER_REFUSED',file=sys.stderr); return 2

if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception:
        print('LINUX_METADATA_OWNER_REFUSED',file=sys.stderr)
        raise SystemExit(2)
