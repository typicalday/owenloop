/* Separate fixed Q2 test API. No production callback/PID/FD/mode payload. */
static const napi_type_tag Q2_IMPORT_BRAND={0x6c3348f90fbc6e92ULL,0xb794ad2e55c70ca1ULL};
static napi_value q2_invoke_two(napi_env env,napi_callback cb,napi_value *args) {
    napi_value fn,receiver,out;
    if(napi_create_function(env,"privateQ2",NAPI_AUTO_LENGTH,cb,NULL,&fn)!=napi_ok||napi_get_undefined(env,&receiver)!=napi_ok)return refused(env,"NAPI");
    if(napi_call_function(env,receiver,fn,2,args,&out)!=napi_ok)return NULL;
    return out;
}
static napi_value q2_import(napi_env env,napi_callback_info info) {
    napi_value args[3];size_t n=3;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=2)return refused(env,"ARGUMENT");
    napi_value value=q2_invoke_two(env,receive_imported,args);
    if(!value)return NULL;
    relay *source=relay_unwrap(env,value,&IMPORT_BRAND);
    if(!source)return refused(env,"ARGUMENT");
    relay *r=calloc(1,sizeof *r);
    if(!r){int clean=relay_dispose(source);source->consumed=1;return refused(env,clean?"ALLOCATION":"CLEANUP");}
    empty_relay(r);r->supervisor_origin=source->supervisor_origin;r->provider_origin=source->provider_origin;
    budget b={now()+5,0,"UNKNOWN"};
    int ok=imported_fence(source,&b)&&alias_handle(&r->supervisor,&source->supervisor,&b)&&
        alias_handle(&r->provider,&source->provider,&b)&&imported_fence(r,&b);
    if(!relay_dispose(source))ok=fail(&b,"CLEANUP");
    source->consumed=1;
    if(!ok){int clean=relay_dispose(r);free(r);return refused(env,clean?b.refusal:"CLEANUP");}
    return relay_wrap(env,r,&Q2_IMPORT_BRAND);
}
static napi_value q2_send(napi_env env,napi_callback_info info) {
    napi_value args[4],out,v;size_t n=4,size=0;char mode[32];
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=3||
       napi_get_value_string_utf8(env,args[2],NULL,0,&size)!=napi_ok||size>=sizeof mode||
       napi_get_value_string_utf8(env,args[2],mode,sizeof mode,&size)!=napi_ok||strlen(mode)!=size)return refused(env,"ARGUMENT");
    int slots[4]={0,1,2,3},count=4,packets=1;
    if(!strcmp(mode,"MISSING_RIGHTS"))count=3;
    else if(!strcmp(mode,"DUPLICATE_RIGHTS")){slots[2]=0;slots[3]=1;}
    else if(!strcmp(mode,"REORDERED_RIGHTS")){slots[0]=2;slots[1]=3;slots[2]=0;slots[3]=1;}
    else if(!strcmp(mode,"TWO_PACKETS"))packets=2;
    else if(strcmp(mode,"VALID"))return refused(env,"ARGUMENT");
    channel *c=getchannel(env,args[0]);relay *r=relay_unwrap(env,args[1],&Q2_IMPORT_BRAND);
    if(!r)return refused(env,"ARGUMENT");
    if(r->consumed)return refused(env,r->cleanup_failed?"CLEANUP":"OWNERSHIP");
    if(!c||c->sender<0||c->sent||c->owner!=getpid())return refused(env,"OWNERSHIP");
    budget b={now()+5,0,"UNKNOWN"};
    if(!imported_fence(r,&b))return refused(env,b.refusal);
    /* First attempt consumes. The second enumerated packet is the fault,
       never a retry of the first or an unknown enqueue outcome. */
    r->consumed=1;c->sent=1;
    int aliases[8],made=0,complete=1,clean=1;
    int source[4]={r->supervisor.pidfd,r->supervisor.fd,r->provider.pidfd,r->provider.fd};
    for(int i=0;i<count*packets;i++){
        int fd=fcntl(source[slots[i%count]],F_DUPFD_CLOEXEC,5);
        if(fd<0){complete=0;break;}
        aliases[made++]=fd;
    }
    if(complete){
        for(int packet=0;packet<packets;packet++){
            char frame[]="JEV_ONE_RELAY_V1";struct iovec io={frame,sizeof frame};
            union {struct cmsghdr align;char bytes[CMSG_SPACE(4*sizeof(int))];} control;
            memset(&control,0,sizeof control);struct msghdr msg={0};
            msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=control.bytes;msg.msg_controllen=CMSG_SPACE((size_t)count*sizeof(int));
            struct cmsghdr *header=CMSG_FIRSTHDR(&msg);
            header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN((size_t)count*sizeof(int));
            memcpy(CMSG_DATA(header),aliases+packet*count,(size_t)count*sizeof(int));
            if(sendmsg(c->sender,&msg,MSG_DONTWAIT|MSG_NOSIGNAL)!=(ssize_t)sizeof frame){complete=0;break;}
        }
    }
    for(int i=0;i<made;i++)if(close(aliases[i]))clean=0;
    int endpoint=closefd(&c->sender),disposed=relay_dispose(r);
    if(!clean||!endpoint||!disposed){r->cleanup_failed=1;return refused(env,"CLEANUP");}
    if(!complete)return refused(env,"CHANNEL");
    if(napi_create_object(env,&out)!=napi_ok||napi_create_string_utf8(env,mode,NAPI_AUTO_LENGTH,&v)!=napi_ok||napi_set_named_property(env,out,"mode",v)!=napi_ok)return refused(env,"NAPI");
    if(napi_create_int32(env,packets,&v)!=napi_ok||napi_set_named_property(env,out,"packets",v)!=napi_ok||napi_create_int32(env,count,&v)!=napi_ok||napi_set_named_property(env,out,"rightsPerPacket",v)!=napi_ok)return refused(env,"NAPI");
    const char *flags[]={"sendComplete","consumed","cleanupKnown"};
    for(size_t i=0;i<sizeof flags/sizeof flags[0];i++){
        if(napi_get_boolean(env,1,&v)!=napi_ok||napi_set_named_property(env,out,flags[i],v)!=napi_ok)return refused(env,"NAPI");
    }
    return out;
}
static napi_value q2_close_import(napi_env env,napi_callback_info info) {
    napi_value args[2],out;size_t n=2;
    if(napi_get_cb_info(env,info,&n,args,NULL,NULL)!=napi_ok||n!=1)return refused(env,"ARGUMENT");
    relay *r=relay_unwrap(env,args[0],&Q2_IMPORT_BRAND);
    if(!r)return refused(env,"ARGUMENT");
    r->consumed=1;
    if(!relay_dispose(r))return refused(env,"CLEANUP");
    if(napi_get_boolean(env,1,&out)!=napi_ok)return refused(env,"NAPI");
    return out;
}
/* Diagnostic-only held-FD checks after the unchanged acceptance joins fail.
   No raw rows retained. CLEANUP dominates; other diagnostic errors suppress
   detail without replacing the original refusal. Same existing budget. */
static int q2_pair_detail(relay *r,handle *role,row role_origin,row sr,row pr,budget *b) {
    if(b->refusal&&!strcmp(b->refusal,"CLEANUP"))return 0;
    budget d=*b;d.refusal="UNKNOWN";row sa,pa;int detail=0;
    if(fence(role,&role_origin,&d,0)&&pidfd_pair(&r->supervisor,&d)&&pidfd_pair(&r->provider,&d)&&
       readrow(r->supervisor.fd,&sa,&d)&&readrow(r->provider.fd,&pa,&d)&&
       incarnation(sr,sa)&&incarnation(pr,pa)&&sa.uid==geteuid()&&pa.uid==geteuid()){
        if(incarnation(sa,pa)&&sa.pid!=role_origin.pid&&sa.ppid==role_origin.pid)detail=22;
        else if(sa.pid!=pa.pid&&sa.pid!=role_origin.pid&&pa.pid!=role_origin.pid&&
                sa.ppid==pa.pid&&pa.ppid==role_origin.pid)detail=23;
    }
    b->bytes=d.bytes;
    if(d.refusal&&!strcmp(d.refusal,"CLEANUP"))fail(b,"CLEANUP");
    return detail;
}
