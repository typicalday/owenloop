import hashlib
import json
import os
from pathlib import Path
import stat
import sys
# This first entry is a separately pinned platform-trusted execution source.
def read(path,cap):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        a=os.fstat(fd)
        if not stat.S_ISREG(a.st_mode) or a.st_nlink!=1 or a.st_size>cap:raise RuntimeError()
        b=b''
        while True:
            x=os.read(fd,8192)
            if not x:break
            b+=x
            if len(b)>cap:raise RuntimeError()
        z=os.fstat(fd);p=path.lstat()
        for k in ['st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns']:
            if getattr(a,k)!=getattr(z,k) or getattr(a,k)!=getattr(p,k):raise RuntimeError()
        return b
    finally:os.close(fd)
try:
    if len(sys.argv)!=2:raise RuntimeError()
    admission_path=Path(sys.argv[1]);a=json.loads(read(admission_path,65536))
    root=Path(__file__).resolve().parent;manifest=read(root/'manifest.json',65536)
    if hashlib.sha256(manifest).hexdigest()!=a['sourceManifestSha256']:raise RuntimeError()
    m=json.loads(manifest);expected=next(x for x in m['files'] if x['relative']=='owner.py')
    raw=read(root/'owner.py',65536)
    if hashlib.sha256(raw).hexdigest()!=expected['sha256'] or len(raw)!=expected['bytes']:raise RuntimeError()
    namespace={'__name__':'jev_one_relay_owner','__file__':str(root/'owner.py')}
    exec(compile(raw,str(root/'owner.py'),'exec'),namespace)
    raise SystemExit(namespace['main'](admission_path))
except Exception:
    print('JEV_ONE_RELAY_LAUNCH_REFUSED',file=sys.stderr);raise SystemExit(2)
