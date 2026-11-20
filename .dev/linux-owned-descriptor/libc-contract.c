#define _GNU_SOURCE
#include <features.h>
#if !defined(__linux__) || !defined(__GLIBC__) || !__GLIBC_PREREQ(2,36)
#error PUBLIC_GLIBC_236_REQUIRED
#endif
#include <sys/pidfd.h>
#include <gnu/libc-version.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(void) {
    /* Link/load public wrapper without acquiring any target descriptor. */
    int (*volatile wrapper)(pid_t,unsigned int)=pidfd_open;
    const char *version=gnu_get_libc_version();
    char *end=NULL;
    if(!wrapper||!version||strlen(version)>32)return 2;
    unsigned long major=strtoul(version,&end,10);
    if(end==version||*end!='.')return 2;
    const char *minor_text=end+1;
    unsigned long minor=strtoul(minor_text,&end,10);
    if(end==minor_text||*end||major!=2||minor<36)return 2;
    if(puts("JEV_PUBLIC_GLIBC_PIDFD_ABI_V1")<0)return 2;
    return 0;
}
