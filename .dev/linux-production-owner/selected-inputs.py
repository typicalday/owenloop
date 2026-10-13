# Executed later only from the manifest-verified buffer by the retained owner.
# Metadata-only omitted inputs remain distinguishable from original absence.
import os
import stat
import time
from pathlib import Path

def shape(s):
 return tuple(getattr(s,k) for k in ('st_dev','st_ino','st_uid','st_gid','st_mode','st_size','st_nlink','st_mtime_ns','st_ctime_ns'))

MIB=1048576
PARTITIONS={'initial':288*MIB,'ownNode':128*MIB,'modules':192*MIB,
 'addons':40*MIB,'headers':17*MIB,'selected':128*MIB,'compiler':64*MIB,
 'late':64*MIB,'native':32*MIB,'metadata':16*MIB}
CHILD_PARTITIONS=('ownNode','modules','addons','headers','compiler')
class SelectedRefusal(RuntimeError):pass
class IntegrityMeter:
 def __init__(self):
  self.used={k:0 for k in PARTITIONS};self.kind='initial';self.child_reserved=sum(PARTITIONS[k] for k in CHILD_PARTITIONS)
 def __getitem__(self,k):return sum(self.used.values()) if k==0 else self.child_reserved
 def __setitem__(self,k,value):
  if k!=0:raise SelectedRefusal('ACCOUNTING')
  delta=value-sum(self.used.values());self.charge(self.kind,delta)
 def charge(self,kind,n):
  if kind not in self.used or type(n) is not int or n<0:raise SelectedRefusal('ACCOUNTING')
  # Nonrefundable attempted byte charges, including rejected bytes.
  self.used[kind]+=n
  if self.used[kind]>PARTITIONS[kind] or sum(self.used.values())+self.child_reserved>1073741824:raise SelectedRefusal('ACCOUNTING')
 def child(self,kind,n):
  if kind not in CHILD_PARTITIONS or type(n) is not int or n<0:raise SelectedRefusal('ACCOUNTING')
  self.used[kind]+=n;self.child_reserved-=n
  if self.used[kind]>PARTITIONS[kind] or self.child_reserved<0 or sum(self.used.values())+self.child_reserved>1073741824:raise SelectedRefusal('ACCOUNTING')
 def report(self):return {'protocol':'jev-selected-integrity-meter-v1','actualBytes':dict(self.used),'reservedBytes':self.child_reserved,'envelopeBytes':1016070144,'totalCapBytes':1073741824,'fitMeasured':False}

# Complete runtime packages are declared, rather than guessed raw-resource suffixes.
RUNTIME_PACKAGES=('node_modules/semver/','node_modules/yaml/','node_modules/@cfworker/json-schema/')
def selected_candidate(rel):
 return rel.startswith(RUNTIME_PACKAGES+('node_modules/typescript/',)) or rel.endswith(('.ts','.mts','.cts','.js','.mjs','.cjs','.json'))
def selected_installed(installation,project,deadline,interrupted,read,write,meter,custody):
 root=installation/'node_modules';dest=project/'node_modules';dest.mkdir(mode=0o700)
 entries=[['node_modules','DIRECTORY',0]];selected=[];links=[];seen=set();fds=[];iters=[];stack=[]
 storage=262144;operations=0;directories=0;selected_bytes=0;uncertain=False
 custody.update(cleanupKnown=False,resources=(fds,iters))
 def need(v):
  if not v:raise SelectedRefusal('SELECTION')
 def check():need(not interrupted[0] and time.monotonic()<deadline)
 def op(fn):
  nonlocal operations
  check();operations+=1;need(operations<=260000);return fn()
 def reserve_ops(n):
  nonlocal operations
  check();operations+=n;need(operations<=260000)
 def retain(n):
  nonlocal storage
  storage+=n;need(storage<=8388608)
 def acquired(container,fn):
  record=[None,False];container.append(record);record[0]=op(fn);return record
 def operations_close():
  nonlocal operations
  operations+=1
  if operations>262144:raise SelectedRefusal('METADATA_CAP')
 def close(record,iterator=False):
  nonlocal uncertain
  if record[0] is None or record[1]:return
  record[1]=True
  try:operations_close()
  except BaseException:uncertain=True;custody['cleanupKnown']=False
  try:
   if iterator:record[0].close()
   else:os.close(record[0])
  except BaseException:uncertain=True;custody['cleanupKnown']=False
  # Keep uncertain registered records. Never retry their numeric descriptors.
  if not uncertain:
   (iters if iterator else fds).remove(record)
 def descend(parent,name,rel,depth):
  nonlocal directories
  need(depth<=64 and len(stack)<65 and directories<4096)
  rec=acquired(fds,lambda:os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent))
  z=op(lambda:os.fstat(rec[0]));need(stat.S_ISDIR(z.st_mode) and z.st_uid==os.getuid())
  ident=(z.st_dev,z.st_ino);need(ident not in seen);retain(256);seen.add(ident);directories+=1
  iterator=acquired(iters,lambda:os.scandir(rec[0]));retain(1024+4*len(os.fsencode(rel)))
  stack.append((rec,iterator,rel,depth,z))
 try:
  descend(None,str(root),'node_modules',0)
  while stack:
   check();rec,it,parent,depth,z=stack[-1]
   try:e=op(lambda:next(it[0]))
   except StopIteration:
    need(shape(op(lambda:os.fstat(rec[0])))==shape(z))
    close(it,True);close(rec);need(not uncertain)
    stack.pop();storage-=1024+4*len(os.fsencode(parent));continue
   name=e.name;need(type(name) is str and name.isascii() and name not in ('','.','..') and '/' not in name)
   rel=parent+'/'+name;need(len(os.fsencode(rel))<=4096 and len(entries)<32768)
   a=op(lambda:os.stat(name,dir_fd=rec[0],follow_symlinks=False))
   retain(192+4*len(os.fsencode(rel)))
   if stat.S_ISDIR(a.st_mode):
    entries.append([rel,'DIRECTORY',0]);op(lambda:(project/rel).mkdir(mode=0o700))
    descend(rec[0],name,rel,depth+1)
   elif stat.S_ISLNK(a.st_mode):
    target=op(lambda:os.readlink(name,dir_fd=rec[0]));need(not os.path.isabs(target) and '\x00' not in target);need(len(os.fsencode(target))<=4096)
    final=os.path.normpath(os.path.join(os.path.dirname(rel),target));need(final!='..' and not final.startswith('../'))
    retain(4*len(os.fsencode(final))+4*len(os.fsencode(target))+128);entries.append([rel,'LINK',0]);links.append([rel,final,target])
   elif stat.S_ISREG(a.st_mode):
    need(a.st_uid==os.getuid() and a.st_nlink==1 and a.st_size>=0)
    choose=selected_candidate(rel);entries.append([rel,'CONTENT' if choose else 'METADATA_ONLY',a.st_size])
    if choose:
     selected_bytes+=a.st_size;need(selected_bytes<=64*MIB and len(selected)<16384)
     # All components are retained no-follow original directory capabilities.
     fdpath=Path('/proc/self/fd')/str(rec[0])/name;meter.kind='selected'
     holder=[None,False];fds.append(holder)
     try:
      reserve_ops(5);raw,pin,fd,before=read(fdpath,512*MIB,deadline,meter);holder[0]=fd
      need(shape(a)==shape(before));p=project/rel;reserve_ops(3);write(p,raw)
      copy_holder=[None,False];fds.append(copy_holder)
      try:
       reserve_ops(5);copy,copy_pin,copyfd,cz=read(p,512*MIB,deadline,meter);copy_holder[0]=copyfd
       need(copy==raw and copy_pin==pin)
      finally:close(copy_holder)
      retain(256);selected.append({'relative':rel,**pin})
     finally:close(holder)
     need(not uncertain)
   else:raise SelectedRefusal('TYPE')
  # All symlinks stay relative within the new owned tree. They are not leaf content authority.
  for rel,final,target in links:
   p=project/rel;op(lambda:os.symlink(target,p))
  custody['cleanupKnown']=not uncertain
  return {'protocol':'jev-selected-original-catalog-v1','entries':entries,'links':links,
          'selected':selected,'metadataOps':operations,'logicalStorageBytes':storage,
          'selectedBytes':selected_bytes,'snapshotOnly':True}
 finally:
  for record in reversed(tuple(iters)):close(record,True)
  for record in reversed(tuple(fds)):close(record)
  custody['cleanupKnown']=not uncertain
