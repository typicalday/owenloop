#define _GNU_SOURCE
#include <node_api.h>
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
    pid_t pid;
    uid_t uid;
    struct stat identity;
}
handle;
static const napi_type_tag BRAND={
    0xc316dd0abe6f4791ULL,0xb4e6bf439f9b2a6fULL
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
        b->refusal="DEADLINE";
        return 0;
    }
    return 1;
}
static int fail(budget *b,const char *code) {
    b->refusal=code;
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
    if(field<=22||!r->start||!r->pgid||r->pgid>INT32_MAX||r->ppid>INT32_MAX||r->count<2||r->count>=CAP)return fail(b,"COUNT");
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
static void finalizer(napi_env env,void *data,void *hint) {
    (void)env;
    (void)hint;
    handle *h=data;
    if(h){
        if(h->fd>=0)close(h->fd);
        free(h);
    }
}
static handle *gethandle(napi_env env,napi_callback_info info) {
    napi_value args[2];
    size_t n=2;
    void *h=NULL;
    napi_valuetype t;
    bool branded=false;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1||napi_typeof(env,args[0],&t)!=napi_ok||t!=napi_object||napi_check_object_type_tag(env,args[0],&BRAND,&branded)!=napi_ok||!branded||napi_unwrap(env,args[0],&h)!=napi_ok||!h)return NULL;
    return h;
}
static napi_value acquire(napi_env env,napi_callback_info info) {
    napi_value args[2],out;
    size_t n=2;
    double pid=0;
    napi_valuetype t;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1||napi_typeof(env,args[0],&t)!=napi_ok||t!=napi_number||napi_get_value_double(env,args[0],&pid)!=napi_ok||!(pid>=1&&pid<=INT32_MAX)||(double)(int)pid!=pid)return refused(env,"ARGUMENT");
    if(getuid()!=geteuid())return refused(env,"UID");
    int proc=open("/proc",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(proc<0)return refused(env,"ACCESS");
    struct statfs f;
    char name[32];
    snprintf(name,sizeof name,"%d",(int)pid);
    if(fstatfs(proc,&f)||f.f_type!=PROC_MAGIC){
        close(proc);
        return refused(env,"FILESYSTEM");
    }
    int fd=openat(proc,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    int err=close(proc);
    if(fd<0)return refused(env,err?"CLEANUP":"ACCESS");
    handle *h=calloc(1,sizeof(*h));
    if(!h){
        close(fd);
        return refused(env,"ALLOCATION");
    }
    h->fd=fd;
    h->pid=(pid_t)pid;
    h->uid=geteuid();
    if(err||fstat(fd,&h->identity)){
        close(fd);
        free(h);
        return refused(env,"CLEANUP");
    }
    if(napi_create_object(env,&out)!=napi_ok||napi_type_tag_object(env,out,&BRAND)!=napi_ok||napi_wrap(env,out,h,finalizer,NULL,NULL)!=napi_ok){
        close(fd);
        free(h);
        return refused(env,"NAPI");
    }
    return out;
}
static napi_value close_handle(napi_env env,napi_callback_info info) {
    handle *h=gethandle(env,info);
    if(!h||h->fd<0)return refused(env,"CLOSED");
    int fd=h->fd;
    h->fd=-1;
    if(close(fd))return refused(env,"CLEANUP");
    napi_value v;
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value sample(napi_env env,napi_callback_info info) {
    handle *h=gethandle(env,info);
    if(!h||h->fd<0)return refused(env,"CLOSED");
    budget b={
        now()+5,0,"UNKNOWN"
    };
    int task=-1,fds[CAP],second=-1,ok=1;
    size_t n=0,m=0;
    uint64_t ids[CAP],last[CAP];
    struct stat shapes[CAP],a,z;
    row first,final,rows[CAP],r;
    for(size_t i=0;i<CAP;i++)fds[i]=-1;
    if(getuid()!=h->uid||geteuid()!=h->uid||fstat(h->fd,&a)||!same(a,h->identity)){
        ok=fail(&b,"IDENTITY");
        goto done;
    }
    if(!readrow(h->fd,&first,&b)||first.pid!=(uint64_t)h->pid||first.tgid!=(uint64_t)h->pid||first.uid!=h->uid){
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
    if(!readrow(h->fd,&final,&b)||!equalrow(first,final)||fstat(h->fd,&z)||!same(z,h->identity)||getuid()!=h->uid||geteuid()!=h->uid||!bound(&b)){
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
static napi_value init(napi_env env,napi_value out){
    napi_property_descriptor methods[]={
        {
            "acquire",NULL,acquire,NULL,NULL,NULL,napi_default,NULL
        },{
            "sample",NULL,sample,NULL,NULL,NULL,napi_default,NULL
        },{
            "close",NULL,close_handle,NULL,NULL,NULL,napi_default,NULL
        }
    };
    if(napi_define_properties(env,out,3,methods)!=napi_ok)return refused(env,"NAPI");
    return out;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
