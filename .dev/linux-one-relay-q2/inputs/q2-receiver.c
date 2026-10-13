static napi_value q2_receive_chain(napi_env env,napi_callback_info info) {
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
    int q2_extra_rights=0,q2_extra_headers=0,q2_extra_credentials=0,q2_extra_credential_shape=0;struct ucred q2_extra_cred={0};
    if(extra_length!=0||extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))bad=1;
    if(extra_length>=0){
        for(struct cmsghdr *q=CMSG_FIRSTHDR(&extra_msg);q;q=CMSG_NXTHDR(&extra_msg,q)){
            bad=1;
            if(q->cmsg_level==SOL_SOCKET&&q->cmsg_type==SCM_RIGHTS&&q->cmsg_len>=CMSG_LEN(0)){
                size_t bytes=q->cmsg_len-CMSG_LEN(0);
                size_t k=bytes/sizeof(int);q2_extra_headers++;
                if(bytes%sizeof(int)==0&&k<=CAP)q2_extra_rights+=(int)k;
                else q2_extra_rights=-CAP;
                for(size_t i=0;i<k;i++){
                    int fd;
                    memcpy(&fd,(char *)CMSG_DATA(q)+i*sizeof(int),sizeof fd);
                    if(close(fd))cleanup_ok=0;
                }
            }
            else if(q->cmsg_level==SOL_SOCKET&&q->cmsg_type==SCM_CREDENTIALS){
                q2_extra_credentials++;
                if(q->cmsg_len==CMSG_LEN(sizeof q2_extra_cred)){
                    memcpy(&q2_extra_cred,CMSG_DATA(q),sizeof q2_extra_cred);q2_extra_credential_shape=1;
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
        /* Q2 detail describes received bytes/rights, not requested sender mode.
           All primary, extra-message and receiver closes already attempted. */
        if(clean&&length==(ssize_t)sizeof expected&&!memcmp(frame,expected,sizeof expected)&&
           !(msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))&&rights_headers==1&&cred_headers==1&&
           cred.pid==c->owner&&cred.uid==getuid()&&cred.gid==getgid()&&alive(c->owner_pidfd)){
            int detail=0;
            if(count==3&&extra_length==0&&!(extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)))detail=21;
            else if(count==4&&extra_length==(ssize_t)sizeof expected&&!memcmp(extra,expected,sizeof expected)&&
                    !(extra_msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC))&&q2_extra_headers==1&&q2_extra_rights==4&&
                    q2_extra_credentials==1&&q2_extra_credential_shape&&q2_extra_cred.pid==c->owner&&
                    q2_extra_cred.uid==getuid()&&q2_extra_cred.gid==getgid())detail=24;
            if(detail){
                budget d=b;d.refusal="UNKNOWN";
                if(fence(role,&role_origin,&d,0)&&child_live(role->pid))c->negative_detail=detail;
                if(d.refusal&&!strcmp(d.refusal,"CLEANUP")){clean=0;c->negative_detail=0;}
                b.bytes=d.bytes;
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
    int q2_rows=0;
    int ok=alias_handle(&r->role,role,&b);
    if(ok&&(fstatfs(r->supervisor.fd,&fs)||fs.f_type!=PROC_MAGIC||
       fstat(r->supervisor.fd,&r->supervisor.identity)||!S_ISDIR(r->supervisor.identity.st_mode)||
       fstatfs(r->provider.fd,&fs)||fs.f_type!=PROC_MAGIC||
       fstat(r->provider.fd,&r->provider.identity)||!S_ISDIR(r->provider.identity.st_mode)||
       !readrow(r->supervisor.fd,&supervisor_row,&b)||!readrow(r->provider.fd,&provider_row,&b)))ok=fail(&b,"PAIR");
    if(ok){
        q2_rows=1;
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
    if(!ok){
        int detail=q2_rows?q2_pair_detail(r,role,role_origin,supervisor_row,provider_row,&b):0;
        int clean=relay_dispose(r);free(r);
        if(clean&&(!b.refusal||strcmp(b.refusal,"CLEANUP"))&&detail)c->negative_detail=detail;
        return refused(env,clean?b.refusal:"CLEANUP");
    }
    return relay_wrap(env,r,&RELAY_BRAND);
}
