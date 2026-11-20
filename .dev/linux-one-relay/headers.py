import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import time
import urllib.request
SHA='ac07673009b92d70f3d842df28204e92785234bae6b4d5785f63fbca8408fc69'
def need(v):
    if not v:raise RuntimeError('HEADER_REFUSED')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):raise RuntimeError('HEADER_REFUSED')
def main():
    need(len(sys.argv)==2);out=Path(sys.argv[1]);need(out.is_dir() and not out.is_symlink())
    deadline=time.monotonic()+20;raw=bytearray()
    opener=urllib.request.build_opener(NoRedirect)
    with opener.open('https://nodejs.org/dist/v22.23.0/node-v22.23.0-headers.tar.gz',timeout=10) as response:
        need(response.status==200)
        while True:
            need(time.monotonic()<deadline);b=response.read(65536)
            if not b:break
            raw.extend(b);need(len(raw)<=16*1024*1024)
    need(hashlib.sha256(raw).hexdigest()==SHA)
    wanted={'node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'};found={};count=0;total=0
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
        for item in archive:
            need(time.monotonic()<deadline);count+=1;total+=item.size
            need(count<=8192 and 0<=item.size<=16*1024*1024 and total<=128*1024*1024)
            prefix='node-v22.23.0/include/node/'
            name=item.name[len(prefix):] if item.name.startswith(prefix) else ''
            if name not in wanted:continue
            need(name not in found and item.isfile() and item.size<=65536)
            with archive.extractfile(item) as f:b=f.read(65537)
            need(len(b)==item.size)
            fd=os.open(out/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            try:
                view=memoryview(b)
                while view:
                    n=os.write(fd,view);need(n>0);view=view[n:]
                os.fsync(fd)
            finally:os.close(fd)
            found[name]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}
    need(set(found)==wanted and time.monotonic()<deadline)
    print(json.dumps({'protocol':'jev-owned-pair-headers-v1','archiveSha256':SHA,'archiveBytes':len(raw),'selected':found},separators=(',',':')))
if __name__=='__main__':
    try:main()
    except BaseException:print('JEV_HEADERS_REFUSED',file=sys.stderr);raise SystemExit(2)
