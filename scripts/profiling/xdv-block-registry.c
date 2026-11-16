#include "xdv-block-registry.h"
#include <stdio.h>
#include <string.h>
#define REGISTRY_SIZE 128
typedef struct {
  void *document;
  uint64_t epoch, serial;
  int page, valid;
  fz_matrix transform;
  char tag[80];
} block_identity;
static block_identity identities[REGISTRY_SIZE];
static uint64_t resource_epoch=1, serial;
static char nonce[33];
static int initialized, available;

static void initialize(void)
{
  unsigned char random[16];
  initialized=1;
  FILE *file=fopen("/dev/urandom","rb");
  if(!file)return;
  available=fread(random,1,sizeof random,file)==sizeof random;
  fclose(file);
  if(available)for(int i=0;i<16;i++)sprintf(nonce+i*2,"%02x",random[i]);
}
const char *txp_xdv_pdf_tag(void *document,int page,fz_matrix transform)
{
  if(!initialized)initialize();
  if(!available || !document || serial==UINT64_MAX)return NULL;
  for(int i=0;i<REGISTRY_SIZE;i++) {
    block_identity *b=&identities[i];
    if(b->valid && b->epoch==resource_epoch && b->document==document && b->page==page &&
      !memcmp(&b->transform,&transform,sizeof transform))return b->tag;
  }
  uint64_t id=++serial;
  block_identity *b=&identities[id%REGISTRY_SIZE];
  *b=(block_identity){.document=document,.page=page,.transform=transform,.epoch=resource_epoch,.serial=id,.valid=1};
  snprintf(b->tag,sizeof b->tag,"txp-xdv-%s-%llu",nonce,(unsigned long long)id);
  return b->tag;
}
int txp_xdv_registered(const char *tag)
{
  if(!tag)return 0;
  for(int i=0;i<REGISTRY_SIZE;i++)if(identities[i].valid && identities[i].epoch==resource_epoch &&
    !strcmp(tag,identities[i].tag))return 1;
  return 0;
}
void txp_xdv_abort(const char *tag)
{
  if(tag)for(int i=0;i<REGISTRY_SIZE;i++)if(!strcmp(tag,identities[i].tag))identities[i].valid=0;
}
void txp_xdv_resource_changed(void)
{
  // Never allow an invalidated/freed resource's recycled address to match an
  // old identity. Invalidate all resources conservatively, not just this file.
  if(++resource_epoch==0) { available=0; memset(identities,0,sizeof identities); }
}
