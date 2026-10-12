#define _GNU_SOURCE
#include <node_api.h>
#include <features.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#if defined(__linux__) && defined(__GLIBC__)
#if __GLIBC_PREREQ(2,36)
#include <sys/pidfd.h>
#define PUBLIC_PIDFD 1
#endif
#endif
#ifndef PUBLIC_PIDFD
#define PUBLIC_PIDFD 0
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <time.h>
#include <unistd.h>
#define CAP 128
#define READ_CAP 16384
#define TOTAL_CAP (8U*1024U*1024U)
#define PROC_MAGIC 0x9fa0
typedef struct {
    int fd;
    int pidfd;
    int owner_pidfd;
    pid_t parent_pid;
    pid_t pid;
    uid_t uid;
    struct stat identity;
}
handle;
static const napi_type_tag BRAND={
    0x6208c81331da7545ULL,0x9c23bdf2a0098107ULL
};
typedef struct {
    uint64_t pid,ppid,pgid,start,count,tgid,uid;
    char state;
}
row;
typedef struct {
    double end;
    size_t bytes;
    const char *refusal;
}
budget;
static double now(void) {
    struct timespec t;
    if(clock_gettime(CLOCK_MONOTONIC,&t))return -1;
    return t.tv_sec+t.tv_nsec/1e9;
}
static int bound(budget *b) {
    double t=now();
    if(t<0||t>=b->end){
        if(!b->refusal||strcmp(b->refusal,"CLEANUP"))b->refusal="DEADLINE";
        return 0;
    }
    return 1;
}
static int fail(budget *b,const char *code) {
    /* Once a close is uncertain, no enclosing classification may erase it. */
    if(!b->refusal||strcmp(b->refusal,"CLEANUP"))b->refusal=code;
    return 0;
}
static napi_value refused(napi_env env,const char *code) {
    napi_throw_error(env,code,code);
    return NULL;
}
static int same(struct stat a,struct stat b) {
    return a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&a.st_uid==b.st_uid&&a.st_mode==b.st_mode;
}
static int number(const char *s,uint64_t *v) {
    if(!s||!*s||(*s=='0'&&s[1]))return 0;
    uint64_t n=0;
    for(;*s;s++){
        if(*s<'0'||*s>'9'||n>(UINT64_MAX-(unsigned)(*s-'0'))/10)return 0;
        n=n*10+(unsigned)(*s-'0');
    }
    *v=n;
    return 1;
}
static int input(int dir,const char *name,char *buf,size_t cap,budget *b) {
    if(!bound(b))return 0;
    int fd=openat(dir,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)return fail(b,"ACCESS");
    size_t n=0;
    int ok=1;
    struct stat a,z;
    if(fstat(fd,&a)||!S_ISREG(a.st_mode))ok=fail(b,"SHAPE");
    while(ok){
        if(!bound(b)){
            ok=0;
            break;
        }
        ssize_t k=read(fd,buf+n,cap-n);
        if(k<0){
            ok=fail(b,"ACCESS");
            break;
        }
        if(!k)break;
        n+=(size_t)k;
        b->bytes+=(size_t)k;
        if(n==cap||b->bytes>TOTAL_CAP){
            ok=fail(b,"CAP");
            break;
        }
    }
    if(ok&&(fstat(fd,&z)||!same(a,z)))ok=fail(b,"IDENTITY");
    if(close(fd))ok=fail(b,"CLEANUP");
    if(!ok)return 0;
    if(!n||buf[n-1]!='\n'||memchr(buf,0,n))return fail(b,"SHAPE");
    buf[n]=0;
    return 1;
}
static int statrow(char *buf,row *r,budget *b) {
    char *open=strchr(buf,'('),*close=strrchr(buf,')');
    if(!open||!close||close<open||close[1]!=' ')return fail(b,"SHAPE");
    if(open==buf||open[-1]!=' ')return fail(b,"SHAPE");
    open[-1]=0;
    if(!number(buf,&r->pid)||!r->pid||r->pid>INT32_MAX)return fail(b,"SHAPE");
    char *save=NULL,*v=strtok_r(close+2," \n",&save);
    if(!v||strlen(v)!=1)return fail(b,"SHAPE");
    r->state=*v;
    unsigned field=4;
    while((v=strtok_r(NULL," \n",&save))){
        uint64_t n;
        if(field==4||field==5||field==20||field==22){
            if(!number(v,&n))return fail(b,"SHAPE");
            if(field==4)r->ppid=n;
            if(field==5)r->pgid=n;
            if(field==20)r->count=n;
            if(field==22)r->start=n;
        }
        if(++field>65)return fail(b,"SHAPE");
    }
    if(field<=22||!r->start||!r->pgid||r->pgid>INT32_MAX||r->ppid>INT32_MAX||r->count<1||r->count>=CAP)return fail(b,"COUNT");
    if(r->state!='R'&&r->state!='S'&&r->state!='D')return fail(b,"STATE");
    return 1;
}
static int statusrow(char *buf,row *r,budget *b) {
    int tgid=0,uid=0,tracer=0;
    char *save=NULL;
    for(char *line=strtok_r(buf,"\n",&save);line;line=strtok_r(NULL,"\n",&save)){
        if(!strncmp(line,"Tgid:\t",6)){
            if(tgid++||!number(line+6,&r->tgid)||!r->tgid||r->tgid>INT32_MAX)return fail(b,"SHAPE");
        }
        else if(!strncmp(line,"Uid:\t",5)){
            if(uid++)return fail(b,"SHAPE");
            char *s=NULL;
            unsigned count=0;
            uint64_t first=0;
            for(char *v=strtok_r(line+5," \t",&s);v;v=strtok_r(NULL," \t",&s)){
                uint64_t n;
                if(!number(v,&n)||n>UINT32_MAX||count>=4)return fail(b,"SHAPE");
                if(count&&n!=first)return fail(b,"UID");
                first=n;
                count++;
            }
            if(count!=4)return fail(b,"SHAPE");
            r->uid=first;
        }
        else if(!strncmp(line,"TracerPid:\t",11)){
            uint64_t n;
            if(tracer++||!number(line+11,&n)||n)return fail(b,"STATE");
        }
    }
    return tgid==1&&uid==1&&tracer==1?1:fail(b,"SHAPE");
}
static int readrow(int fd,row *r,budget *b) {
    char st[4097],status[READ_CAP+1];
    memset(r,0,sizeof(*r));
    return input(fd,"stat",st,4096,b)&&statrow(st,r,b)&&input(fd,"status",status,READ_CAP,b)&&statusrow(status,r,b);
}
static int equalrow(row a,row z) {
    return a.pid==z.pid&&a.ppid==z.ppid&&a.pgid==z.pgid&&a.start==z.start&&a.count==z.count&&a.tgid==z.tgid&&a.uid==z.uid;
}
static int list(int task,uint64_t *ids,size_t *count,budget *b) {
    int fd=openat(task,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)return fail(b,"ACCESS");
    DIR *d=fdopendir(fd);
    if(!d){
        int err=close(fd);
        return fail(b,err?"CLEANUP":"ACCESS");
    }
    size_t n=0;
    int ok=1;
    errno=0;
    for(;;){
        if(!bound(b)){
            ok=0;
            break;
        }
        errno=0;
        struct dirent *e=readdir(d);
        if(!e){
            if(errno)ok=fail(b,"ACCESS");
            break;
        }
        if(!strcmp(e->d_name,".")||!strcmp(e->d_name,".."))continue;
        uint64_t id;
        if(!number(e->d_name,&id)||!id||id>INT32_MAX||n>=CAP-1){
            ok=fail(b,"CAP");
            break;
        }
        for(size_t j=0;j<n;j++)if(ids[j]==id){
            ok=fail(b,"DUPLICATE");
            break;
        }
        if(!ok)break;
        ids[n++]=id;
    }
    if(closedir(d))ok=fail(b,"CLEANUP");
    if(ok&&n<2)ok=fail(b,"COUNT");
    *count=n;
    return ok;
}
/* Native backing is private to the fixed source facade. No inspect(pid) API. */
static int closefd(int *fd) {
    int v=*fd;
    *fd=-1;
    return v<0||close(v)==0;
}
static int alive(int fd) {
    struct pollfd p={fd,POLLIN|POLLHUP|POLLERR,0};
    return fd>=0&&poll(&p,1,0)==0&&p.revents==0;
}
static int child_live(pid_t pid) {
    siginfo_t s;
    struct sigaction a;
    memset(&s,0,sizeof s);
    if(sigaction(SIGCHLD,NULL,&a)||a.sa_handler==SIG_IGN||(a.sa_flags&SA_NOCLDWAIT))return 0;
    return waitid(P_PID,(id_t)pid,&s,WEXITED|WNOHANG|WNOWAIT)==0&&s.si_pid==0;
}
static int dispose(handle *h) {
    int a=closefd(&h->fd),b=closefd(&h->pidfd),c=closefd(&h->owner_pidfd);
    return a&&b&&c;
}
static void finalizer(napi_env env,void *data,void *hint) {
    (void)env;
    (void)hint;
    handle *h=data;
    if(h){
        dispose(h);
        free(h);
    }
}
static handle *unwrap(napi_env env,napi_value v) {
    void *h=NULL;
    napi_valuetype t;
    bool branded=false;
    if(napi_typeof(env,v,&t)!=napi_ok||t!=napi_object||napi_check_object_type_tag(env,v,&BRAND,&branded)!=napi_ok||!branded||napi_unwrap(env,v,&h)!=napi_ok)return NULL;
    return h;
}
static handle *gethandle(napi_env env,napi_callback_info info) {
    napi_value args[2];
    size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return NULL;
    return unwrap(env,args[0]);
}
static napi_value wrap(napi_env env,handle *h) {
    napi_value out;
    if(napi_create_object(env,&out)!=napi_ok||napi_type_tag_object(env,out,&BRAND)!=napi_ok||napi_wrap(env,out,h,finalizer,NULL,NULL)!=napi_ok){
        int clean=dispose(h);
        free(h);
        return refused(env,clean?"NAPI":"CLEANUP");
    }
    return out;
}
static int pidfd_pair(handle *h,budget *b);
static handle *bind_original(pid_t pid,const char **code) {
    handle *h=NULL;
    int proc=-1;
    row a,z;
    budget b={now()+5,0,"UNKNOWN"};
    *code="OWNERSHIP";
    if(getuid()!=geteuid()||getgid()!=getegid()||!child_live(pid))return NULL;
#if PUBLIC_PIDFD
    h=calloc(1,sizeof(*h));
    if(!h){*code="ALLOCATION";return NULL;}
    h->fd=-1;h->owner_pidfd=-1;h->parent_pid=getpid();
    h->pidfd=pidfd_open(pid,0);
    h->pid=pid;
    h->uid=geteuid();
    if(h->pidfd<0){*code="UNSUPPORTED";goto bad;}
#else
    (void)a;
    (void)z;
    (void)b;
    *code="UNSUPPORTED";
    return NULL;
#endif
    if(!alive(h->pidfd))goto bad;
    proc=open("/proc",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    struct statfs f;
    char name[32];
    if(proc<0||fstatfs(proc,&f)||f.f_type!=PROC_MAGIC){*code="FILESYSTEM";goto bad;}
    snprintf(name,sizeof name,"%d",(int)pid);
    h->fd=openat(proc,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(!closefd(&proc)){*code="CLEANUP";goto bad;}
    if(h->fd<0||fstat(h->fd,&h->identity)||!S_ISDIR(h->identity.st_mode)||!readrow(h->fd,&a,&b)){
        *code="IDENTITY";goto bad;
    }
    if(a.pid!=(uint64_t)pid||a.tgid!=(uint64_t)pid||a.ppid!=(uint64_t)getpid()||a.uid!=h->uid||!child_live(pid)||!alive(h->pidfd)||!readrow(h->fd,&z,&b)||a.pid!=z.pid||a.ppid!=z.ppid||a.pgid!=z.pgid||a.start!=z.start||a.tgid!=z.tgid||a.uid!=z.uid||!bound(&b))goto bad;
    if(!pidfd_pair(h,&b)||!child_live(pid)||!alive(h->pidfd)||!bound(&b)){*code="PAIR";goto bad;}
    return h;
    bad:
    if(b.refusal&&!strcmp(b.refusal,"CLEANUP"))*code="CLEANUP";
    if(!closefd(&proc))*code="CLEANUP";
    if(h){
        if(!dispose(h))*code="CLEANUP";
        free(h);
    }
    return NULL;
}
/* This calls a trusted source-owned callback that performs cp.spawn once. */
static napi_value spawn_and_bind(napi_env env,napi_callback_info info) {
    napi_value args[2],child,receiver,pv,exitv,signalv,out,hv;
    size_t n=2;
    napi_valuetype t;
    double pid=0;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1||napi_typeof(env,args[0],&t)!=napi_ok||t!=napi_function)return refused(env,"ARGUMENT");
    if(napi_get_undefined(env,&receiver)!=napi_ok||napi_call_function(env,receiver,args[0],0,NULL,&child)!=napi_ok)return NULL;
    if(napi_typeof(env,child,&t)!=napi_ok||t!=napi_object||napi_get_named_property(env,child,"pid",&pv)!=napi_ok||napi_get_value_double(env,pv,&pid)!=napi_ok||!(pid>=1&&pid<=INT32_MAX)||(double)(pid_t)pid!=pid||napi_get_named_property(env,child,"exitCode",&exitv)!=napi_ok||napi_typeof(env,exitv,&t)!=napi_ok||t!=napi_null||napi_get_named_property(env,child,"signalCode",&signalv)!=napi_ok||napi_typeof(env,signalv,&t)!=napi_ok||t!=napi_null)return refused(env,"OWNERSHIP");
    const char *code;
    handle *h=bind_original((pid_t)pid,&code);
    if(!h)return refused(env,code);
    hv=wrap(env,h);
    if(!hv)return NULL;
    if(napi_create_object(env,&out)!=napi_ok||napi_set_named_property(env,out,"child",child)!=napi_ok||napi_set_named_property(env,out,"handle",hv)!=napi_ok){
        int clean=dispose(h);
        return refused(env,clean?"NAPI":"CLEANUP");
    }
    return out;
}
static napi_value close_handle(napi_env env,napi_callback_info info) {
    handle *h=gethandle(env,info);
    if(!h||h->fd<0||h->pidfd<0)return refused(env,"CLOSED");
    if(!dispose(h))return refused(env,"CLEANUP");
    napi_value v;
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value sample(napi_env env,napi_callback_info info) {
    handle *h=gethandle(env,info);
    if(!h||h->fd<0||h->pidfd<0)return refused(env,"CLOSED");
    budget b={
        now()+5,0,"UNKNOWN"
    };
    int task=-1,fds[CAP],second=-1,ok=1;
    size_t n=0,m=0;
    uint64_t ids[CAP],last[CAP];
    struct stat shapes[CAP],a,z;
    row first,final,rows[CAP],r;
    for(size_t i=0;i<CAP;i++)fds[i]=-1;
    if(!alive(h->pidfd)||(h->owner_pidfd>=0&&!alive(h->owner_pidfd))||getuid()!=h->uid||geteuid()!=h->uid||fstat(h->fd,&a)||!same(a,h->identity)){
        ok=fail(&b,"IDENTITY");
        goto done;
    }
    if(!readrow(h->fd,&first,&b)||first.pid!=(uint64_t)h->pid||first.tgid!=(uint64_t)h->pid||first.ppid!=(uint64_t)h->parent_pid||first.uid!=h->uid){
        ok=fail(&b,"IDENTITY");
        goto done;
    }
    task=openat(h->fd,"task",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(task<0){
        ok=fail(&b,"ACCESS");
        goto done;
    }
    if(!list(task,ids,&n,&b)||n!=first.count){
        ok=fail(&b,"COUNT");
        goto done;
    }
    for(size_t i=0;i<n;i++){
        char name[32];
        snprintf(name,sizeof name,"%llu",(unsigned long long)ids[i]);
        if(!bound(&b)){
            ok=0;
            goto done;
        }
        fds[i]=openat(task,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
        if(fds[i]<0||fstat(fds[i],&shapes[i])||!readrow(fds[i],&rows[i],&b)){
            ok=0;
            if(!b.refusal||!strcmp(b.refusal,"UNKNOWN"))fail(&b,"ACCESS");
            goto done;
        }
        if(rows[i].pid!=ids[i]||rows[i].tgid!=first.pid||rows[i].uid!=h->uid||rows[i].count!=n){
            ok=fail(&b,"IDENTITY");
            goto done;
        }
    }
    /* Complete second EOF enumeration/count precedes EVERY second state read. */
    if(!list(task,last,&m,&b)||m!=n||!readrow(h->fd,&final,&b)||final.count!=n||!equalrow(first,final)){
        ok=fail(&b,"SET_CHANGED");
        goto done;
    }
    for(size_t i=0;i<n;i++){
        size_t found=0;
        for(size_t j=0;j<m;j++)if(last[j]==ids[i])found++;
        if(found!=1){
            ok=fail(&b,"SET_CHANGED");
            goto done;
        }
        char name[32];
        snprintf(name,sizeof name,"%llu",(unsigned long long)ids[i]);
        second=openat(task,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
        if(second<0||fstat(second,&z)||!same(z,shapes[i])||fstat(fds[i],&a)||!same(a,z)){
            ok=fail(&b,"IDENTITY");
            goto done;
        }
        if(close(second)){
            second=-1;
            ok=fail(&b,"CLEANUP");
            goto done;
        }
        second=-1;
        if(!readrow(fds[i],&r,&b)||!equalrow(rows[i],r)){
            ok=0;
            if(!strcmp(b.refusal,"UNKNOWN"))fail(&b,"IDENTITY");
            goto done;
        }
    }
    if(!readrow(h->fd,&final,&b)||!equalrow(first,final)||fstat(h->fd,&z)||!same(z,h->identity)||getuid()!=h->uid||geteuid()!=h->uid||!bound(&b)||!alive(h->pidfd)||(h->owner_pidfd>=0&&!alive(h->owner_pidfd))){
        ok=0;
        if(!strcmp(b.refusal,"UNKNOWN"))fail(&b,"IDENTITY");
    }
    done:
    if(second>=0&&close(second))ok=fail(&b,"CLEANUP");
    for(size_t i=0;i<CAP;i++)if(fds[i]>=0&&close(fds[i]))ok=fail(&b,"CLEANUP");
    if(task>=0&&close(task))ok=fail(&b,"CLEANUP");
    if(!ok)return refused(env,b.refusal);
    napi_value out,v;
    if(napi_create_object(env,&out)!=napi_ok)return refused(env,"NAPI");
    if(napi_create_uint32(env,(uint32_t)n,&v)!=napi_ok||napi_set_named_property(env,out,"count",v)!=napi_ok)return refused(env,"NAPI");
    const char *keys[]={
        "twoPasses","allStatesLive","sameTaskDescriptors","sameProcessIdentity","completeEOF","cleanupKnown"
    };
    for(size_t i=0;i<sizeof(keys)/sizeof(keys[0]);i++)if(napi_get_boolean(env,1,&v)!=napi_ok||napi_set_named_property(env,out,keys[i],v)!=napi_ok)return refused(env,"NAPI");
    return out;
}

typedef struct {
    int receiver,sender,owner_pidfd;
    pid_t owner;
    int sent,received,negative_detail;
}
channel;
static const napi_type_tag CHANNEL_BRAND={0x2dd335a00dd5ff1bULL,0x8afa6934c2db7e48ULL};
static int channel_dispose(channel *c) {
    int a=closefd(&c->receiver),b=closefd(&c->sender),d=closefd(&c->owner_pidfd);
    return a&&b&&d;
}
static void channel_finalizer(napi_env env,void *data,void *hint) {
    (void)env;
    (void)hint;
    channel *c=data;
    if(c){channel_dispose(c);free(c);}
}
static channel *getchannel(napi_env env,napi_value v) {
    bool tagged=false;
    void *p=NULL;
    if(napi_check_object_type_tag(env,v,&CHANNEL_BRAND,&tagged)!=napi_ok||!tagged||napi_unwrap(env,v,&p)!=napi_ok)return NULL;
    return p;
}
static napi_value channel_object(napi_env env,channel *c) {
    napi_value out;
    if(napi_create_object(env,&out)!=napi_ok||napi_type_tag_object(env,out,&CHANNEL_BRAND)!=napi_ok||napi_wrap(env,out,c,channel_finalizer,NULL,NULL)!=napi_ok){
        int clean=channel_dispose(c);free(c);return refused(env,clean?"NAPI":"CLEANUP");
    }
    return out;
}
static napi_value create_channel(napi_env env,napi_callback_info info) {
    size_t n=1;
    napi_value args[1];
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n)return refused(env,"ARGUMENT");
    channel *c=calloc(1,sizeof(*c));
    if(!c)return refused(env,"ALLOCATION");
    c->receiver=c->sender=c->owner_pidfd=-1;
    int pair[2];
    if(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK,0,pair)){
        free(c);return refused(env,"UNSUPPORTED");
    }
    c->receiver=pair[0];c->sender=pair[1];c->owner=getpid();
    int yes=1;
    if(setsockopt(c->receiver,SOL_SOCKET,SO_PASSCRED,&yes,sizeof yes)){
        int clean=channel_dispose(c);free(c);return refused(env,clean?"CHANNEL":"CLEANUP");
    }
    return channel_object(env,c);
}
static napi_value inherited_sender(napi_env env,napi_callback_info info) {
    size_t n=1;
    napi_value args[1];
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n)return refused(env,"ARGUMENT");
    int type=0;
    socklen_t size=sizeof type;
    struct ucred peer;
    socklen_t ps=sizeof peer;
    if(getsockopt(4,SOL_SOCKET,SO_TYPE,&type,&size)||size!=sizeof type||type!=SOCK_SEQPACKET||getsockopt(4,SOL_SOCKET,SO_PEERCRED,&peer,&ps)||ps!=sizeof peer||peer.pid!=getppid()||peer.uid!=getuid()||peer.gid!=getgid()){
        int clean=close(4)==0;
        return refused(env,clean?"CHANNEL":"CLEANUP");
    }
    int fd=fcntl(4,F_DUPFD_CLOEXEC,5);
    int flags=fd>=0?fcntl(fd,F_GETFL):0;
    if(fd<0||flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK)){
        int a=closefd(&fd),b=close(4)==0;
        return refused(env,a&&b?"CHANNEL":"CLEANUP");
    }
    /* The inherited slot must not escape to this owner's target. */
    if(close(4)){closefd(&fd);return refused(env,"CLEANUP");}
    channel *c=calloc(1,sizeof(*c));
    if(!c){int clean=closefd(&fd);return refused(env,clean?"ALLOCATION":"CLEANUP");}
    c->receiver=c->owner_pidfd=-1;c->sender=fd;c->owner=getpid();
    return channel_object(env,c);
}
static napi_value sender_fd(napi_env env,napi_callback_info info) {
    napi_value args[2],v;
    size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    if(!c||c->sender<0||c->sent)return refused(env,"CLOSED");
    if(napi_create_int32(env,c->sender,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value attribute_owner(napi_env env,napi_callback_info info) {
    napi_value args[3],v;
    size_t n=3;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    handle *h=unwrap(env,args[1]);
    if(!c||!h||c->receiver<0||c->received||c->sent||c->owner_pidfd>=0||!alive(h->pidfd)||!child_live(h->pid))return refused(env,"OWNERSHIP");
    c->owner_pidfd=fcntl(h->pidfd,F_DUPFD_CLOEXEC,5);
    if(c->owner_pidfd<0)return refused(env,"CHANNEL");
    c->owner=h->pid;
    if(!closefd(&c->sender))return refused(env,"CLEANUP");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value send_pair(napi_env env,napi_callback_info info) {
    napi_value args[3],v;
    size_t n=3;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    handle *h=unwrap(env,args[1]);
    if(!c||!h||c->sender<0||c->sent||!alive(h->pidfd)||!child_live(h->pid))return refused(env,"OWNERSHIP");
    c->sent=1; /* Single use consumes even an uncertain enqueue outcome. */
    char frame[]="JEV_PAIR_V1";
    struct iovec io={frame,sizeof frame};
    union {struct cmsghdr align;char bytes[CMSG_SPACE(2*sizeof(int))];} control;
    memset(&control,0,sizeof control);
    struct msghdr msg={0};
    msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=sizeof control.bytes;
    struct cmsghdr *header=CMSG_FIRSTHDR(&msg);
    header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(2*sizeof(int));
    int rights[2]={h->pidfd,h->fd};
    memcpy(CMSG_DATA(header),rights,sizeof rights);
    ssize_t sent=sendmsg(c->sender,&msg,MSG_DONTWAIT|MSG_NOSIGNAL);
    int a=closefd(&c->sender),b=dispose(h);
    if(!a||!b)return refused(env,"CLEANUP");
    if(sent!=(ssize_t)sizeof frame)return refused(env,"CHANNEL");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
/* Private negative fixture only: no caller PID, FD, payload or arbitrary mode.
   Every alias comes from the same already-bound genuine original pair. */
static napi_value send_negative(napi_env env,napi_callback_info info) {
    napi_value args[4],v;
    size_t n=4,size=0;
    char mode[32];
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=3||
       napi_get_value_string_utf8(env,args[2],NULL,0,&size)!=napi_ok||size>=sizeof mode||
       napi_get_value_string_utf8(env,args[2],mode,sizeof mode,&size)!=napi_ok||strlen(mode)!=size)
        return refused(env,"ARGUMENT");
    int count;
    if(!strcmp(mode,"MALFORMED_FRAME"))count=2;
    else if(!strcmp(mode,"EXTRA_RIGHTS"))count=3;
    else if(!strcmp(mode,"TRUNCATED_RIGHTS"))count=CAP+16;
    else return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    handle *h=unwrap(env,args[1]);
    if(!c||!h||c->receiver<0||c->sender<0||c->sent||c->received||
       c->owner!=getpid()||c->owner_pidfd>=0||!alive(h->pidfd)||!child_live(h->pid))
        return refused(env,"OWNERSHIP");
    c->sent=1;
    int rights[CAP+16],made=0,clean=1;
    for(int i=0;i<count;i++){
        int fd=fcntl(i%2?h->fd:h->pidfd,F_DUPFD_CLOEXEC,5);
        if(fd<0)break;
        rights[made++]=fd;
    }
    char frame[]="JEV_PAIR_V1";
    if(!strcmp(mode,"MALFORMED_FRAME"))frame[0]='X';
    struct iovec io={frame,sizeof frame};
    union {struct cmsghdr align;char bytes[CMSG_SPACE((CAP+16)*sizeof(int))];} control;
    memset(&control,0,sizeof control);
    struct msghdr msg={0};
    msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control.bytes;
    msg.msg_controllen=CMSG_SPACE((size_t)count*sizeof(int));
    struct cmsghdr *header=CMSG_FIRSTHDR(&msg);
    header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;
    header->cmsg_len=CMSG_LEN((size_t)count*sizeof(int));
    ssize_t sent=-1;
    if(made==count){
        memcpy(CMSG_DATA(header),rights,(size_t)count*sizeof(int));
        sent=sendmsg(c->sender,&msg,MSG_DONTWAIT|MSG_NOSIGNAL);
    }
    /* No retries, including close uncertainty. Do not short-circuit cleanup. */
    for(int i=0;i<made;i++)if(close(rights[i]))clean=0;
    int a=closefd(&c->sender),b=dispose(h);
    if(!clean||!a||!b)return refused(env,"CLEANUP");
    if(made!=count||sent!=(ssize_t)sizeof frame)return refused(env,"CHANNEL");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
/* Closed, fixed diagnostic over an already-refused receive; no descriptor data.
   It is not an authority assertion or an alternative successful receive. */
static napi_value negative_detail(napi_env env,napi_callback_info info) {
    napi_value args[2],v;
    size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    if(!c)return refused(env,"ARGUMENT");
    const char *detail="UNKNOWN";
    if(c->received&&c->receiver<0){
        if(c->negative_detail==1)detail="MALFORMED_FRAME";
        else if(c->negative_detail==2)detail="EXTRA_RIGHTS";
        else if(c->negative_detail==3)detail="CONTROL_TRUNCATED";
    }
    if(napi_create_string_utf8(env,detail,NAPI_AUTO_LENGTH,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static int pidfd_pair(handle *h,budget *b) {
    int own=open("/proc/self/fdinfo",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    struct statfs fs;
    if(own<0||fstatfs(own,&fs)||fs.f_type!=PROC_MAGIC){
        int clean=closefd(&own);return fail(b,clean?"PAIR":"CLEANUP");
    }
    char name[32],data[4097];
    snprintf(name,sizeof name,"%d",h->pidfd);
    int ok=own>=0&&input(own,name,data,4096,b);
    if(!closefd(&own))return fail(b,"CLEANUP");
    if(!ok)return fail(b,"PAIR");
    int found=0;
    uint64_t pid=0;
    char *save=NULL;
    for(char *line=strtok_r(data,"\n",&save);line;line=strtok_r(NULL,"\n",&save)){
        if(!strncmp(line,"Pid:\t",5)){
            if(found++||!number(line+5,&pid))return fail(b,"PAIR");
        }
    }
    return found==1&&pid==(uint64_t)h->pid&&alive(h->pidfd)?1:fail(b,"PAIR");
}
static napi_value receive_pair(napi_env env,napi_callback_info info) {
    napi_value args[2];
    size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    if(!c||c->receiver<0||c->received||(c->owner_pidfd>=0&&!alive(c->owner_pidfd)))return refused(env,"OWNERSHIP");
    c->received=1;
    char frame[32];
    struct iovec io={frame,sizeof frame};
    /* Space for bounded unexpected rights; all delivered FDs are closed. */
    union {struct cmsghdr align;char bytes[CMSG_SPACE(CAP*sizeof(int))+CMSG_SPACE(sizeof(struct ucred))];} control;
    memset(&control,0,sizeof control);
    struct msghdr msg={0};
    msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=sizeof control.bytes;
    ssize_t length=recvmsg(c->receiver,&msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
    int rights[CAP],count=0,rights_headers=0,cred_headers=0,bad=0,cleanup_ok=1;
    struct ucred cred={0};
    if(length<0){
        int clean=closefd(&c->receiver);
        return refused(env,clean?"CHANNEL":"CLEANUP");
    }
    for(struct cmsghdr *p=CMSG_FIRSTHDR(&msg);p;p=CMSG_NXTHDR(&msg,p)){
        if(p->cmsg_len<CMSG_LEN(0)){bad=1;break;}
        size_t bytes=p->cmsg_len-CMSG_LEN(0);
        if(p->cmsg_level==SOL_SOCKET&&p->cmsg_type==SCM_RIGHTS){
            rights_headers++;
            if(bytes%sizeof(int))bad=1;
            size_t k=bytes/sizeof(int);
            for(size_t i=0;i<k;i++){
                int fd;
                memcpy(&fd,(char *)CMSG_DATA(p)+i*sizeof(int),sizeof fd);
                if(count<CAP)rights[count++]=fd;
                else {if(close(fd))cleanup_ok=0;bad=1;}
            }
        }
        else if(p->cmsg_level==SOL_SOCKET&&p->cmsg_type==SCM_CREDENTIALS){
            cred_headers++;
            if(bytes!=sizeof cred)bad=1;
            else memcpy(&cred,CMSG_DATA(p),sizeof cred);
        }
#ifdef SCM_PIDFD
        else if(p->cmsg_level==SOL_SOCKET&&p->cmsg_type==SCM_PIDFD){
            bad=1;
            if(bytes==sizeof(int)){
                int fd;memcpy(&fd,CMSG_DATA(p),sizeof fd);
                if(close(fd))cleanup_ok=0;
            }
        }
#endif
        else bad=1;
    }
    /* A successful sender closes its only sender endpoint. Require exact EOF,
       not a second packet or a still-open channel; no waiting or retry. */
    char extra[32];
    struct iovec extra_io={extra,sizeof extra};
    union {struct cmsghdr align;char bytes[CMSG_SPACE(CAP*sizeof(int))+CMSG_SPACE(sizeof(struct ucred))];} extra_control;
    memset(&extra_control,0,sizeof extra_control);
    struct msghdr extra_msg={0};
    extra_msg.msg_iov=&extra_io;extra_msg.msg_iovlen=1;
    extra_msg.msg_control=extra_control.bytes;extra_msg.msg_controllen=sizeof extra_control.bytes;
    ssize_t extra_length=recvmsg(c->receiver,&extra_msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
    if(extra_length!=0||extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))bad=1;
    if(extra_length>=0){
        for(struct cmsghdr *q=CMSG_FIRSTHDR(&extra_msg);q;q=CMSG_NXTHDR(&extra_msg,q)){
            bad=1;
            if(q->cmsg_level==SOL_SOCKET&&q->cmsg_type==SCM_RIGHTS&&q->cmsg_len>=CMSG_LEN(0)){
                size_t k=(q->cmsg_len-CMSG_LEN(0))/sizeof(int);
                for(size_t i=0;i<k;i++){
                    int fd;
                    memcpy(&fd,(char *)CMSG_DATA(q)+i*sizeof(int),sizeof fd);
                    if(close(fd))cleanup_ok=0;
                }
            }
#ifdef SCM_PIDFD
            else if(q->cmsg_level==SOL_SOCKET&&q->cmsg_type==SCM_PIDFD&&q->cmsg_len==CMSG_LEN(sizeof(int))){
                int fd;memcpy(&fd,CMSG_DATA(q),sizeof fd);
                if(close(fd))cleanup_ok=0;
            }
#endif
        }
    }
    if(!closefd(&c->receiver)){cleanup_ok=0;bad=1;}
    const char expected[]="JEV_PAIR_V1";
    if(length!=(ssize_t)sizeof expected||memcmp(frame,expected,sizeof expected)||msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)||rights_headers!=1||cred_headers!=1||count!=2||cred.pid!=c->owner||cred.uid!=getuid()||cred.gid!=getgid()||(c->owner_pidfd>=0&&!alive(c->owner_pidfd)))bad=1;
    if(bad){
        int clean=cleanup_ok;
        for(int i=0;i<count;i++)if(close(rights[i]))clean=0;
        /* Publish a reason only after every delivered right was explicitly
           closed successfully. All original acceptance predicates stay above. */
        if(clean){
            if(msg.msg_flags&MSG_CTRUNC)c->negative_detail=3;
            else if(length==(ssize_t)sizeof expected&&!(msg.msg_flags&MSG_TRUNC)&&
                    rights_headers==1&&cred_headers==1&&extra_length==0&&
                    !(extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))&&
                    cred.pid==c->owner&&cred.uid==getuid()&&cred.gid==getgid()&&
                    (c->owner_pidfd<0||alive(c->owner_pidfd))){
                if(count==2&&memcmp(frame,expected,sizeof expected))c->negative_detail=1;
                else if(count>2&&!memcmp(frame,expected,sizeof expected))c->negative_detail=2;
            }
        }
        return refused(env,clean?"CHANNEL":"CLEANUP");
    }
    handle *h=calloc(1,sizeof(*h));
    if(!h){
        int a=close(rights[0]),b=close(rights[1]);
        return refused(env,a||b?"CLEANUP":"ALLOCATION");
    }
    h->pidfd=rights[0];h->fd=rights[1];h->uid=geteuid();h->owner_pidfd=-1;h->parent_pid=c->owner;
    if(c->owner_pidfd>=0){
        h->owner_pidfd=fcntl(c->owner_pidfd,F_DUPFD_CLOEXEC,5);
        if(h->owner_pidfd<0){int clean=dispose(h);free(h);return refused(env,clean?"PAIR":"CLEANUP");}
    }
    row r;
    budget budget={now()+5,0,"UNKNOWN"};
    struct statfs fs;
    if(getuid()!=h->uid||!alive(h->pidfd)||fstatfs(h->fd,&fs)||fs.f_type!=PROC_MAGIC||fstat(h->fd,&h->identity)||!S_ISDIR(h->identity.st_mode)||!readrow(h->fd,&r,&budget)||r.uid!=h->uid||r.pid!=r.tgid||r.ppid!=(uint64_t)cred.pid){
        int clean=dispose(h);free(h);return refused(env,clean&&strcmp(budget.refusal,"CLEANUP")?"PAIR":"CLEANUP");
    }
    h->pid=(pid_t)r.pid;
    if(!pidfd_pair(h,&budget)||!bound(&budget)){
        int clean=dispose(h);free(h);return refused(env,clean&&strcmp(budget.refusal,"CLEANUP")?"PAIR":"CLEANUP");
    }
    return wrap(env,h);
}
static napi_value close_channel(napi_env env,napi_callback_info info) {
    napi_value args[2],v;
    size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    if(!c)return refused(env,"ARGUMENT");
    if(!channel_dispose(c))return refused(env,"CLEANUP");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value init(napi_env env,napi_value out){
    napi_property_descriptor methods[]={
        {"spawnAndBind",NULL,spawn_and_bind,NULL,NULL,NULL,napi_default,NULL},
        {"sample",NULL,sample,NULL,NULL,NULL,napi_default,NULL},
        {"close",NULL,close_handle,NULL,NULL,NULL,napi_default,NULL},
        {"createChannel",NULL,create_channel,NULL,NULL,NULL,napi_default,NULL},
        {"inheritedSender",NULL,inherited_sender,NULL,NULL,NULL,napi_default,NULL},
        {"senderFD",NULL,sender_fd,NULL,NULL,NULL,napi_default,NULL},
        {"attributeOwner",NULL,attribute_owner,NULL,NULL,NULL,napi_default,NULL},
        {"sendPair",NULL,send_pair,NULL,NULL,NULL,napi_default,NULL},
        {"sendNegative",NULL,send_negative,NULL,NULL,NULL,napi_default,NULL},
        {"negativeDetail",NULL,negative_detail,NULL,NULL,NULL,napi_default,NULL},
        {"receivePair",NULL,receive_pair,NULL,NULL,NULL,napi_default,NULL},
        {"closeChannel",NULL,close_channel,NULL,NULL,NULL,napi_default,NULL}
    };
    if(napi_define_properties(env,out,sizeof methods/sizeof methods[0],methods)!=napi_ok)return refused(env,"NAPI");
    return out;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
