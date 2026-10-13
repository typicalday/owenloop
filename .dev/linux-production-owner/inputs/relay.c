/* Private fixed ONE-relay component. Old direct source is included unchanged.
   Public NAPI registration is suppressed only for that included translation unit. */
#define _GNU_SOURCE
#include <node_api.h>
#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc)
#include "direct/descriptor.c"
#undef NAPI_MODULE

typedef struct {
    handle supervisor, provider, role;
    row supervisor_origin, provider_origin, role_origin;
    int consumed, cleanup_failed, has_role;
} relay;
static const napi_type_tag IMPORT_BRAND={0x439fd2cb731ea260ULL,0xad0414c2af29536cULL};
static const napi_type_tag RELAY_BRAND={0x8d4c96ee09474521ULL,0x625f7bb1e2cf164aULL};
static void empty_handle(handle *h) {
    memset(h,0,sizeof *h);
    h->fd=h->pidfd=h->owner_pidfd=-1;
}
static void empty_relay(relay *r) {
    memset(r,0,sizeof *r);
    empty_handle(&r->supervisor);empty_handle(&r->provider);empty_handle(&r->role);
}
static int relay_dispose(relay *r) {
    int a=dispose(&r->supervisor),b=dispose(&r->provider),c=dispose(&r->role);
    if(!a||!b||!c)r->cleanup_failed=1;
    return !r->cleanup_failed;
}
static void relay_finalizer(napi_env env,void *data,void *hint) {
    (void)env;(void)hint;
    relay *r=data;
    if(r){relay_dispose(r);free(r);} /* best effort, never cleanup evidence */
}
static relay *relay_unwrap(napi_env env,napi_value v,const napi_type_tag *tag) {
    bool branded=false;void *p=NULL;
    if(napi_check_object_type_tag(env,v,tag,&branded)!=napi_ok||!branded||napi_unwrap(env,v,&p)!=napi_ok)return NULL;
    return p;
}
static napi_value relay_wrap(napi_env env,relay *r,const napi_type_tag *tag) {
    napi_value v;
    if(napi_create_object(env,&v)!=napi_ok||napi_type_tag_object(env,v,tag)!=napi_ok||napi_wrap(env,v,r,relay_finalizer,NULL,NULL)!=napi_ok){
        int clean=relay_dispose(r);free(r);return refused(env,clean?"NAPI":"CLEANUP");
    }
    return v;
}
static int alias_handle(handle *to,const handle *from,budget *b) {
    empty_handle(to);
    if(from->fd<0||from->pidfd<0||!alive(from->pidfd))return fail(b,"CLOSED");
    *to=*from;to->fd=to->pidfd=to->owner_pidfd=-1;
    to->fd=fcntl(from->fd,F_DUPFD_CLOEXEC,5);
    to->pidfd=fcntl(from->pidfd,F_DUPFD_CLOEXEC,5);
    if(from->owner_pidfd>=0)to->owner_pidfd=fcntl(from->owner_pidfd,F_DUPFD_CLOEXEC,5);
    if(to->fd<0||to->pidfd<0||(from->owner_pidfd>=0&&to->owner_pidfd<0)){
        int clean=dispose(to);return fail(b,clean?"PAIR":"CLEANUP");
    }
    return pidfd_pair(to,b);
}
/* Incarnation fences deliberately exclude varying thread count and state.
   readrow still enforces its original finite typed shape/live-state policy. */
static int incarnation(row a,row z) {
    return a.pid==z.pid&&a.ppid==z.ppid&&a.pgid==z.pgid&&a.start==z.start&&a.tgid==z.tgid&&a.uid==z.uid;
}
static int fence(handle *h,row *origin,budget *b,int establish) {
    struct stat s;struct statfs fs;row r;
    if(!bound(b)||getuid()!=geteuid()||getgid()!=getegid()||h->uid!=geteuid()||
       !alive(h->pidfd)||(h->owner_pidfd>=0&&!alive(h->owner_pidfd))||
       fstatfs(h->fd,&fs)||fs.f_type!=PROC_MAGIC||fstat(h->fd,&s)||!same(s,h->identity)||
       !pidfd_pair(h,b)||!readrow(h->fd,&r,b)||r.pid!=(uint64_t)h->pid||r.tgid!=r.pid||
       r.uid!=h->uid||r.ppid!=(uint64_t)h->parent_pid)return fail(b,"IDENTITY");
    if(establish)*origin=r;
    else if(!incarnation(*origin,r))return fail(b,"IDENTITY");
    return bound(b);
}
static int imported_fence(relay *r,budget *b) {
    handle owner=r->supervisor;owner.pidfd=r->provider.owner_pidfd;owner.owner_pidfd=-1;
    if(r->cleanup_failed)return fail(b,"CLEANUP");
    if(r->consumed||r->provider.owner_pidfd<0||
       r->supervisor.parent_pid!=getpid()||!child_live(r->supervisor.pid)||
       r->provider.parent_pid!=r->supervisor.pid||!pidfd_pair(&owner,b)||
       !fence(&r->supervisor,&r->supervisor_origin,b,0)||
       !fence(&r->provider,&r->provider_origin,b,0)){
        if(b->refusal&&!strcmp(b->refusal,"CLEANUP"))r->cleanup_failed=1;
        return fail(b,"OWNERSHIP");
    }
    return 1;
}
static int chain_fence(relay *r,budget *b,int establish) {
    if(r->cleanup_failed)return fail(b,"CLEANUP");
    if(!r->has_role||r->consumed||r->role.parent_pid!=getpid()||
       !child_live(r->role.pid)||r->supervisor.parent_pid!=r->role.pid||
       r->provider.parent_pid!=r->supervisor.pid)return fail(b,"OWNERSHIP");
    int ok=fence(&r->role,&r->role_origin,b,establish)&&
           fence(&r->supervisor,&r->supervisor_origin,b,establish)&&
           fence(&r->provider,&r->provider_origin,b,establish);
    if(b->refusal&&!strcmp(b->refusal,"CLEANUP"))r->cleanup_failed=1;
    return ok;
}
static napi_value invoke_direct(napi_env env,napi_callback cb,napi_value arg) {
    napi_value fn,receiver,out;
    if(napi_create_function(env,"privateDirect",NAPI_AUTO_LENGTH,cb,NULL,&fn)!=napi_ok||napi_get_undefined(env,&receiver)!=napi_ok)return refused(env,"NAPI");
    if(napi_call_function(env,receiver,fn,1,&arg,&out)!=napi_ok)return NULL;
    return out;
}
/* Only this boundary can mint IMPORT_BRAND. Ordinary received/local handles
   cannot be promoted: unchanged receive_pair is invoked here, once, on the
   exact channel attributed to the supplied genuine direct supervisor. */
static napi_value receive_imported(napi_env env,napi_callback_info info) {
    napi_value a[3];size_t n=3;
    if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,a[0]);handle *supervisor=unwrap(env,a[1]);
    budget b={now()+5,0,"UNKNOWN"};row origin;
    if(!c||!supervisor||c->owner_pidfd<0||c->owner!=supervisor->pid||!child_live(supervisor->pid)||
       supervisor->parent_pid!=getpid())return refused(env,"OWNERSHIP");
    if(!fence(supervisor,&origin,&b,1))return refused(env,b.refusal);
    handle attributed=*supervisor;attributed.pidfd=c->owner_pidfd;attributed.owner_pidfd=-1;
    if(!pidfd_pair(&attributed,&b))return refused(env,b.refusal);
    napi_value received=invoke_direct(env,receive_pair,a[0]);
    if(!received)return NULL;
    handle *provider=unwrap(env,received);
    relay *r=calloc(1,sizeof *r);
    if(!r){int clean=provider?dispose(provider):1;return refused(env,clean?"ALLOCATION":"CLEANUP");}
    empty_relay(r);r->supervisor_origin=origin;
    int ok=provider&&provider->parent_pid==supervisor->pid&&provider->owner_pidfd>=0&&
        alias_handle(&r->supervisor,supervisor,&b)&&alias_handle(&r->provider,provider,&b)&&
        fence(&r->provider,&r->provider_origin,&b,1)&&imported_fence(r,&b);
    /* Wrapper owns only CLOEXEC aliases. The ordinary receiver handle is
       disposed explicitly, not entrusted to its eventual GC finalizer. */
    if(provider&&!dispose(provider))ok=fail(&b,"CLEANUP");
    if(!ok){int clean=relay_dispose(r);free(r);return refused(env,clean?b.refusal:"CLEANUP");}
    return relay_wrap(env,r,&IMPORT_BRAND);
}
static napi_value send_chain(napi_env env,napi_callback_info info) {
    napi_value a[3],v;size_t n=3;
    if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,a[0]);relay *r=relay_unwrap(env,a[1],&IMPORT_BRAND);
    budget b={now()+5,0,"UNKNOWN"};
    if(!r)return refused(env,"ARGUMENT");
    if(!c||c->sender<0||c->sent||c->owner!=getpid())return refused(env,"OWNERSHIP");
    if(!imported_fence(r,&b))return refused(env,b.refusal);
    /* First send attempt consumes the envelope and endpoint. No enqueue retry. */
    r->consumed=1;c->sent=1;
    int rights[4]={r->supervisor.pidfd,r->supervisor.fd,r->provider.pidfd,r->provider.fd};
    char frame[]="JEV_ONE_RELAY_V1";struct iovec io={frame,sizeof frame};
    union {struct cmsghdr align;char bytes[CMSG_SPACE(sizeof rights)];} control;
    memset(&control,0,sizeof control);struct msghdr msg={0};
    msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=sizeof control.bytes;
    struct cmsghdr *p=CMSG_FIRSTHDR(&msg);p->cmsg_level=SOL_SOCKET;p->cmsg_type=SCM_RIGHTS;p->cmsg_len=CMSG_LEN(sizeof rights);
    memcpy(CMSG_DATA(p),rights,sizeof rights);
    ssize_t sent=sendmsg(c->sender,&msg,MSG_DONTWAIT|MSG_NOSIGNAL);
    int clean_channel=closefd(&c->sender),clean_aliases=relay_dispose(r);
    if(!clean_channel||!clean_aliases){r->cleanup_failed=1;return refused(env,"CLEANUP");}
    if(sent!=(ssize_t)sizeof frame)return refused(env,"CHANNEL");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}

static napi_value send_chain_negative(napi_env env,napi_callback_info info) {
    napi_value args[4],v;
    size_t n=4,size=0;
    char mode[32];
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=3||
       napi_get_value_string_utf8(env,args[2],NULL,0,&size)!=napi_ok||size>=sizeof mode||
       napi_get_value_string_utf8(env,args[2],mode,sizeof mode,&size)!=napi_ok||strlen(mode)!=size)
        return refused(env,"ARGUMENT");
    int count;
    if(!strcmp(mode,"MALFORMED_FRAME"))count=4;
    else if(!strcmp(mode,"EXTRA_RIGHTS"))count=6;
    else if(!strcmp(mode,"TRUNCATED_RIGHTS"))count=CAP+16;
    else return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);
    relay *r=relay_unwrap(env,args[1],&IMPORT_BRAND);
    budget b={now()+5,0,"UNKNOWN"};
    if(!r)return refused(env,"ARGUMENT");
    if(!c||c->sender<0||c->sent||c->owner!=getpid())return refused(env,"OWNERSHIP");
    if(!imported_fence(r,&b))return refused(env,b.refusal);
    c->sent=1;r->consumed=1;
    int rights[CAP+16],made=0,clean=1;
    for(int i=0;i<count;i++){
        int source[4]={r->supervisor.pidfd,r->supervisor.fd,r->provider.pidfd,r->provider.fd};
        int fd=fcntl(source[i%4],F_DUPFD_CLOEXEC,5);
        if(fd<0)break;
        rights[made++]=fd;
    }
    char frame[]="JEV_ONE_RELAY_V1";
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
    int a=closefd(&c->sender),disposed=relay_dispose(r);
    if(!clean||!a||!disposed){r->cleanup_failed=1;return refused(env,"CLEANUP");}
    if(made!=count||sent!=(ssize_t)sizeof frame)return refused(env,"CHANNEL");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}

/* Distinct new channel diagnostic; old negative_detail API stays unchanged.
   Detail never asserts successful receipt, provenance, or cleanup on failure. */
static napi_value chain_negative_detail(napi_env env,napi_callback_info info) {
    napi_value a[2],v;size_t n=2;
    if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,a[0]);
    if(!c)return refused(env,"ARGUMENT");
    const char *detail="UNKNOWN";
    if(c->received&&c->receiver<0){
        if(c->negative_detail==11)detail="MALFORMED_FRAME";
        else if(c->negative_detail==12)detail="EXTRA_RIGHTS";
        else if(c->negative_detail==13)detail="CONTROL_TRUNCATED";
    }
    if(napi_create_string_utf8(env,detail,NAPI_AUTO_LENGTH,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value receive_chain(napi_env env,napi_callback_info info) {
    napi_value args[3];size_t n=3;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);handle *role=unwrap(env,args[1]);
    budget b={now()+5,0,"UNKNOWN"};row role_origin;
    if(!c||!role||c->receiver<0||c->received||c->owner_pidfd<0||c->owner!=role->pid||
       role->parent_pid!=getpid()||!child_live(role->pid))return refused(env,"OWNERSHIP");
    if(!fence(role,&role_origin,&b,1))return refused(env,b.refusal);
    handle attributed=*role;attributed.pidfd=c->owner_pidfd;attributed.owner_pidfd=-1;
    if(!pidfd_pair(&attributed,&b))return refused(env,b.refusal);
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
    const char expected[]="JEV_ONE_RELAY_V1";
    if(length!=(ssize_t)sizeof expected||memcmp(frame,expected,sizeof expected)||msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)||rights_headers!=1||cred_headers!=1||count!=4||cred.pid!=c->owner||cred.uid!=getuid()||cred.gid!=getgid()||(c->owner_pidfd>=0&&!alive(c->owner_pidfd)))bad=1;
    if(!cleanup_ok)bad=1;
    if(bad){
        int clean=cleanup_ok;
        for(int i=0;i<count;i++)if(close(rights[i]))clean=0;
        /* Only this new receiver publishes chain-frame detail, and only
           after EVERY delivered and EOF-probe right was known closed. */
        if(clean){
            if(msg.msg_flags&MSG_CTRUNC)c->negative_detail=13;
            else if(length==(ssize_t)sizeof expected&&!(msg.msg_flags&MSG_TRUNC)&&
                    rights_headers==1&&cred_headers==1&&extra_length==0&&
                    !(extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))&&
                    cred.pid==c->owner&&cred.uid==getuid()&&cred.gid==getgid()&&
                    alive(c->owner_pidfd)){
                if(count==4&&memcmp(frame,expected,sizeof expected))c->negative_detail=11;
                else if(count>4&&!memcmp(frame,expected,sizeof expected))c->negative_detail=12;
            }
        }
        return refused(env,clean?"CHANNEL":"CLEANUP");
    }
    relay *r=calloc(1,sizeof *r);
    if(!r){
        int clean=1;for(int i=0;i<4;i++)if(close(rights[i]))clean=0;
        return refused(env,clean?"ALLOCATION":"CLEANUP");
    }
    empty_relay(r);r->has_role=1;
    r->supervisor.pidfd=rights[0];r->supervisor.fd=rights[1];
    r->provider.pidfd=rights[2];r->provider.fd=rights[3];
    r->supervisor.uid=r->provider.uid=geteuid();
    row supervisor_row,provider_row;struct statfs fs;
    int ok=alias_handle(&r->role,role,&b);
    if(ok&&(fstatfs(r->supervisor.fd,&fs)||fs.f_type!=PROC_MAGIC||
       fstat(r->supervisor.fd,&r->supervisor.identity)||!S_ISDIR(r->supervisor.identity.st_mode)||
       fstatfs(r->provider.fd,&fs)||fs.f_type!=PROC_MAGIC||
       fstat(r->provider.fd,&r->provider.identity)||!S_ISDIR(r->provider.identity.st_mode)||
       !readrow(r->supervisor.fd,&supervisor_row,&b)||!readrow(r->provider.fd,&provider_row,&b)))ok=fail(&b,"PAIR");
    if(ok){
        r->supervisor.pid=(pid_t)supervisor_row.pid;r->supervisor.parent_pid=role->pid;
        r->provider.pid=(pid_t)provider_row.pid;r->provider.parent_pid=r->supervisor.pid;
        r->supervisor.owner_pidfd=fcntl(r->role.pidfd,F_DUPFD_CLOEXEC,5);
        r->provider.owner_pidfd=fcntl(r->supervisor.pidfd,F_DUPFD_CLOEXEC,5);
        if(r->supervisor.owner_pidfd<0||r->provider.owner_pidfd<0||
           r->supervisor.pid==role->pid||r->provider.pid==role->pid||r->provider.pid==r->supervisor.pid||
           !chain_fence(r,&b,1))ok=fail(&b,"PAIR");
    }
    /* Close aliases cannot erase failure, and the pre-receive role incarnation
       is compared to the established chain alias before exposing it. */
    if(ok&&!incarnation(role_origin,r->role_origin))ok=fail(&b,"IDENTITY");
    if(!ok){int clean=relay_dispose(r);free(r);return refused(env,clean?b.refusal:"CLEANUP");}
    return relay_wrap(env,r,&RELAY_BRAND);
}
/* Capture the standard descriptor builtin once; caller-overwritable addon
   exports are never used for direct invocation or pending-error inspection. */
static napi_ref own_descriptor=NULL;
static napi_env descriptor_env=NULL;
static void release_descriptor(void *data) {
    (void)data;
    if(own_descriptor){napi_delete_reference(descriptor_env,own_descriptor);own_descriptor=NULL;}
}
static void latch_pending_cleanup(napi_env env,relay *r) {
    napi_value error,fn,receiver,key,descriptor,value,value_key,ignored;
    bool pending=false;
    if(napi_is_exception_pending(env,&pending)!=napi_ok||!pending)return;
    if(napi_get_and_clear_last_exception(env,&error)!=napi_ok)return;
    napi_value args[2];args[0]=error;
    if(own_descriptor&&napi_get_reference_value(env,own_descriptor,&fn)==napi_ok&&
       napi_get_undefined(env,&receiver)==napi_ok&&napi_create_string_utf8(env,"code",4,&key)==napi_ok){
        args[1]=key;
        if(napi_call_function(env,receiver,fn,2,args,&descriptor)==napi_ok){
            napi_valuetype type;bool has_value=false;
            if(napi_typeof(env,descriptor,&type)==napi_ok&&type==napi_object&&
               napi_create_string_utf8(env,"value",5,&value_key)==napi_ok&&
               napi_has_own_property(env,descriptor,value_key,&has_value)==napi_ok&&has_value&&
               napi_get_property(env,descriptor,value_key,&value)==napi_ok&&
               napi_typeof(env,value,&type)==napi_ok&&type==napi_string){
                size_t size=0;char code[8];
                if(napi_get_value_string_utf8(env,value,NULL,0,&size)==napi_ok&&size==7&&
                   napi_get_value_string_utf8(env,value,code,sizeof code,&size)==napi_ok&&
                   size==7&&!memcmp(code,"CLEANUP",8))r->cleanup_failed=1;
            }
        }
    }
    /* Inspection failure (including Proxy descriptor traps) is contained.
       The SAME original thrown value is restored, never its string/message. */
    if(napi_is_exception_pending(env,&pending)==napi_ok&&pending)napi_get_and_clear_last_exception(env,&ignored);
    napi_throw(env,error);
}
static napi_value sample_chain(napi_env env,napi_callback_info info) {
    napi_value a[2],borrowed;size_t n=2;
    if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    relay *r=relay_unwrap(env,a[0],&RELAY_BRAND);budget b={now()+5,0,"UNKNOWN"};
    if(!r||!chain_fence(r,&b,0))return refused(env,r?b.refusal:"ARGUMENT");
    /* Temporary internal wrapper has no finalizer; ownership remains r's.
       It cannot escape the native-created synchronous unchanged scanner. */
    if(napi_create_object(env,&borrowed)!=napi_ok||napi_type_tag_object(env,borrowed,&BRAND)!=napi_ok||
       napi_wrap(env,borrowed,&r->provider,NULL,NULL,NULL)!=napi_ok)return refused(env,"NAPI");
    napi_value projection=invoke_direct(env,sample,borrowed);
    if(!projection){latch_pending_cleanup(env,r);return NULL;}
    if(!chain_fence(r,&b,0))return refused(env,b.refusal);
    return projection;
}
static napi_value close_relay(napi_env env,napi_callback_info info) {
    napi_value a[2],v;size_t n=2;
    if(napi_get_cb_info(env,info,&n,a,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    relay *r=relay_unwrap(env,a[0],&RELAY_BRAND);
    if(!r)r=relay_unwrap(env,a[0],&IMPORT_BRAND);
    if(!r)return refused(env,"ARGUMENT");
    r->consumed=1;
    if(!relay_dispose(r))return refused(env,"CLEANUP");
    if(napi_get_boolean(env,1,&v)!=napi_ok)return refused(env,"NAPI");
    return v;
}
static napi_value relay_init(napi_env env,napi_value out) {
    if(own_descriptor)return refused(env,"UNSUPPORTED");
    descriptor_env=env;
    napi_value global,object,descriptor;
    if(napi_get_global(env,&global)!=napi_ok||napi_get_named_property(env,global,"Object",&object)!=napi_ok||
       napi_get_named_property(env,object,"getOwnPropertyDescriptor",&descriptor)!=napi_ok||
       napi_create_reference(env,descriptor,1,&own_descriptor)!=napi_ok||
       napi_add_env_cleanup_hook(env,release_descriptor,NULL)!=napi_ok)return refused(env,"NAPI");
    if(!init(env,out))return NULL;
    napi_property_descriptor methods[]={
        {"chainNegativeDetail",NULL,chain_negative_detail,NULL,NULL,NULL,napi_default,NULL},
        {"sendNegativeChain",NULL,send_chain_negative,NULL,NULL,NULL,napi_default,NULL},
        {"receiveImportedPair",NULL,receive_imported,NULL,NULL,NULL,napi_default,NULL},
        {"sendBoundOwnerChain",NULL,send_chain,NULL,NULL,NULL,napi_default,NULL},
        {"receiveBoundOwnerChain",NULL,receive_chain,NULL,NULL,NULL,napi_default,NULL},
        {"sampleBoundOwnerChain",NULL,sample_chain,NULL,NULL,NULL,napi_default,NULL},
        {"closeRelay",NULL,close_relay,NULL,NULL,NULL,napi_default,NULL}
    };
    if(napi_define_properties(env,out,sizeof methods/sizeof methods[0],methods)!=napi_ok)return refused(env,"NAPI");
    return out;
}
NAPI_MODULE_INIT() {return relay_init(env,exports);}
