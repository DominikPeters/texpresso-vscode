/* Included after the flat fingerprint callbacks. Nonvisual PDF-import markers
 * form ordered hierarchical leaves; a hit skips hashing, never actual drawing.
 * Cache keys include registered resource identity, exact placement, page grid
 * and held rectangle. Outer drawing state remains in the parent cell stream. */
#include "xdv-block-registry.h"
#define BLOCK_CACHE_ENTRIES 16
typedef struct {
  char tag[80];
  int width, count, supported, operations;
  unsigned unsupported;
  fz_irect clip;
  fz_rect bounds;
  unsigned char *keys;
  unsigned long used;
} block_cache_entry;
static block_cache_entry block_cache[BLOCK_CACHE_ENTRIES];
static unsigned long block_clock;
typedef struct {
  fz_device super;
  damage_device *scan;
  fz_sha256 *outer;
  block_cache_entry *hit;
  char tag[80];
  int depth, boundary, skip, operations_before, outer_supported;
  unsigned outer_unsupported;
} block_device;

static int block_cache_enabled(void)
{ const char *v=getenv("TEXPRESSO_BLOCK_CACHE");return !v || strcmp(v,"0"); }
static block_cache_entry *block_lookup(block_device *b,const char *name)
{
  damage_snapshot *s=b->scan->snapshot;
  if(!block_cache_enabled())return NULL;
  for(int i=0;i<BLOCK_CACHE_ENTRIES;i++) {
    block_cache_entry *e=&block_cache[i];
    if(e->keys && !strcmp(e->tag,name) && e->width==b->scan->grid->width &&
       !memcmp(&e->clip,&s->clip,sizeof s->clip) && !memcmp(&e->bounds,&s->bounds,sizeof s->bounds)) {
      e->used=++block_clock;return e;
    }
  }
  return NULL;
}
static void block_leaf(block_device *b,const unsigned char *keys)
{
  const unsigned char domain=0xb7;
  int count=b->scan->snapshot->nx*b->scan->snapshot->ny;
  for(int i=0;i<count;i++) {
    fz_sha256_update(&b->scan->cells[i],&domain,1);
    /* Provenance prevents pointer-derived child hashes matching after the
     * originating display list dies and a resource address is recycled. */
    fz_sha256_update(&b->scan->cells[i],(const unsigned char*)b->tag,strlen(b->tag)+1);
    fz_sha256_update(&b->scan->cells[i],keys+i*32,32);
  }
}
static void block_store(fz_context *ctx,block_device *b,const unsigned char *keys,int supported,unsigned unsupported,int operations)
{
  if(!block_cache_enabled() || !txp_xdv_registered(b->tag))return;
  int slot=0;
  for(int i=0;i<BLOCK_CACHE_ENTRIES;i++) {
    if(!block_cache[i].keys) { slot=i;break; }
    if(block_cache[i].used<block_cache[slot].used)slot=i;
  }
  block_cache_entry *e=&block_cache[slot];damage_snapshot *s=b->scan->snapshot;
  int count=s->nx*s->ny;
  unsigned char *copy=fz_malloc(ctx,(size_t)count*32);memcpy(copy,keys,(size_t)count*32);
  fz_free(ctx,e->keys);
  *e=(block_cache_entry){.width=b->scan->grid->width,.clip=s->clip,.bounds=s->bounds,.keys=copy,
    .count=count,.supported=supported,.unsupported=unsupported,.operations=operations,.used=++block_clock};
  memcpy(e->tag,b->tag,sizeof e->tag);
}
static void block_begin_layer(fz_context *ctx,fz_device *dev,const char *name)
{
  block_device *b=(void*)dev; b->depth++;
  if(b->boundary || !txp_xdv_registered(name))return;
  b->boundary=b->depth;snprintf(b->tag,sizeof b->tag,"%s",name);
  b->hit=block_lookup(b,name);
  if(b->hit) {
    b->skip=1;b->scan->snapshot->block_hits++;
    b->scan->snapshot->cached_operations+=b->hit->operations;
    b->scan->snapshot->supported &= b->hit->supported;
    b->scan->snapshot->unsupported |= b->hit->unsupported;
  } else {
    b->scan->snapshot->block_misses++;
    b->operations_before=b->scan->operations;
    b->outer_supported=b->scan->snapshot->supported;b->outer_unsupported=b->scan->snapshot->unsupported;
    b->scan->snapshot->supported=1;b->scan->snapshot->unsupported=0;
    int count=b->scan->snapshot->nx*b->scan->snapshot->ny;
    fz_sha256 *cells=fz_calloc(ctx,(size_t)count,sizeof *cells);
    for(int i=0;i<count;i++)fz_sha256_init(&cells[i]);
    b->outer=b->scan->cells;b->scan->cells=cells;
  }
}
static void block_end_layer(fz_context *ctx,fz_device *dev)
{
  block_device *b=(void*)dev;
  if(b->depth<=0)fz_throw(ctx,FZ_ERROR_GENERIC,"Experimental block marker underflow");
  if(b->boundary && b->depth==b->boundary) {
    if(b->skip)block_leaf(b,b->hit->keys);
    else {
      int count=b->scan->snapshot->nx*b->scan->snapshot->ny;
      unsigned char *keys=NULL;fz_var(keys);
      fz_try(ctx) {
        keys=fz_malloc(ctx,(size_t)count*32);
        for(int i=0;i<count;i++)fz_sha256_final(&b->scan->cells[i],keys+i*32);
        fz_free(ctx,b->scan->cells);b->scan->cells=b->outer;b->outer=NULL;
        block_leaf(b,keys);
        block_store(ctx,b,keys,b->scan->snapshot->supported,b->scan->snapshot->unsupported,b->scan->operations-b->operations_before);
        b->scan->snapshot->supported &= b->outer_supported;
        b->scan->snapshot->unsupported |= b->outer_unsupported;
      }
      fz_always(ctx)fz_free(ctx,keys);
      fz_catch(ctx)fz_rethrow(ctx);
    }
    b->boundary=0;b->skip=0;b->hit=NULL;
  }
  if(b->depth>0)b->depth--;
}
static void block_close(fz_context *ctx,fz_device *dev)
{
  block_device *b=(void*)dev;
  if(b->boundary || b->depth)fz_throw(ctx,FZ_ERROR_GENERIC,"Unbalanced experimental block markers");
}
static void block_drop(fz_context *ctx,fz_device *dev)
{
  block_device *b=(void*)dev;
  if(b->outer) {fz_free(ctx,b->scan->cells);b->scan->cells=b->outer;b->outer=NULL;}
}

#define BLOCK_FORWARD(name,target,params,args) static void name params { block_device *b=(void*)dev; if(!b->skip)target args; }
BLOCK_FORWARD(block_fill_path,d_fill_path,(fz_context *ctx,fz_device *dev,const fz_path *p,int eo,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp),(ctx,&b->scan->super,p,eo,m,cs,c,a,cp))
BLOCK_FORWARD(block_stroke_path,d_stroke_path,(fz_context *ctx,fz_device *dev,const fz_path *p,const fz_stroke_state *s,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp),(ctx,&b->scan->super,p,s,m,cs,c,a,cp))
BLOCK_FORWARD(block_fill_text,d_fill_text,(fz_context *ctx,fz_device *dev,const fz_text *t,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp),(ctx,&b->scan->super,t,m,cs,c,a,cp))
BLOCK_FORWARD(block_stroke_text,d_stroke_text,(fz_context *ctx,fz_device *dev,const fz_text *t,const fz_stroke_state *s,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp),(ctx,&b->scan->super,t,s,m,cs,c,a,cp))
BLOCK_FORWARD(block_clip_path,d_clip_path,(fz_context *ctx,fz_device *dev,const fz_path *p,int eo,fz_matrix m,fz_rect r),(ctx,&b->scan->super,p,eo,m,r))
BLOCK_FORWARD(block_clip_stroke,d_clip_stroke,(fz_context *ctx,fz_device *dev,const fz_path *p,const fz_stroke_state *s,fz_matrix m,fz_rect r),(ctx,&b->scan->super,p,s,m,r))
BLOCK_FORWARD(block_clip_text,d_clip_text,(fz_context *ctx,fz_device *dev,const fz_text *t,fz_matrix m,fz_rect r),(ctx,&b->scan->super,t,m,r))
BLOCK_FORWARD(block_clip_stroke_text,d_clip_stroke_text,(fz_context *ctx,fz_device *dev,const fz_text *t,const fz_stroke_state *s,fz_matrix m,fz_rect r),(ctx,&b->scan->super,t,s,m,r))
BLOCK_FORWARD(block_pop,d_pop,(fz_context *ctx,fz_device *dev),(ctx,&b->scan->super))
BLOCK_FORWARD(block_group,d_group,(fz_context *ctx,fz_device *dev,fz_rect r,fz_colorspace *cs,int isolated,int knockout,int blend,float a),(ctx,&b->scan->super,r,cs,isolated,knockout,blend,a))
BLOCK_FORWARD(block_end_group,d_end_group,(fz_context *ctx,fz_device *dev),(ctx,&b->scan->super))
BLOCK_FORWARD(block_flags,d_flags,(fz_context *ctx,fz_device *dev,int set,int clear),(ctx,&b->scan->super,set,clear))
BLOCK_FORWARD(block_defaults,d_defaults,(fz_context *ctx,fz_device *dev,fz_default_colorspaces *cs),(ctx,&b->scan->super,cs))
BLOCK_FORWARD(block_image,d_image,(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,float a,fz_color_params cp),(ctx,&b->scan->super,i,m,a,cp))
BLOCK_FORWARD(block_image_mask,d_image_mask,(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp),(ctx,&b->scan->super,i,m,cs,c,a,cp))
BLOCK_FORWARD(block_clip_image,d_clip_image,(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,fz_rect r),(ctx,&b->scan->super,i,m,r))
BLOCK_FORWARD(block_shade,d_shade,(fz_context *ctx,fz_device *dev,fz_shade *s,fz_matrix m,float a,fz_color_params cp),(ctx,&b->scan->super,s,m,a,cp))
BLOCK_FORWARD(block_mask,d_mask,(fz_context *ctx,fz_device *dev,fz_rect r,int lum,fz_colorspace *cs,const float *c,fz_color_params cp),(ctx,&b->scan->super,r,lum,cs,c,cp))
BLOCK_FORWARD(block_end_mask,d_end_mask,(fz_context *ctx,fz_device *dev,fz_function *fn),(ctx,&b->scan->super,fn))
BLOCK_FORWARD(block_end_tile,d_end_tile,(fz_context *ctx,fz_device *dev),(ctx,&b->scan->super))
static int block_tile(fz_context *ctx,fz_device *dev,fz_rect r,fz_rect v,float x,float y,fz_matrix m,int id,int doc)
{block_device *b=(void*)dev;return b->skip?0:d_tile(ctx,&b->scan->super,r,v,x,y,m,id,doc);}
#undef BLOCK_FORWARD

static fz_device *block_proxy(fz_context *ctx,damage_device *scan)
{
  block_device *b=fz_new_derived_device(ctx,block_device); b->scan=scan;
  b->super.close_device=block_close;b->super.drop_device=block_drop;
  b->super.begin_layer=block_begin_layer;b->super.end_layer=block_end_layer;
  b->super.fill_path=block_fill_path;b->super.stroke_path=block_stroke_path;
  b->super.fill_text=block_fill_text;b->super.stroke_text=block_stroke_text;
  b->super.clip_path=block_clip_path;b->super.clip_stroke_path=block_clip_stroke;
  b->super.clip_text=block_clip_text;b->super.clip_stroke_text=block_clip_stroke_text;
  b->super.pop_clip=block_pop;b->super.begin_group=block_group;b->super.end_group=block_end_group;
  b->super.render_flags=block_flags;b->super.set_default_colorspaces=block_defaults;
  b->super.fill_image=block_image;b->super.fill_image_mask=block_image_mask;b->super.clip_image_mask=block_clip_image;
  b->super.fill_shade=block_shade;b->super.begin_mask=block_mask;b->super.end_mask=block_end_mask;
  b->super.begin_tile=block_tile;b->super.end_tile=block_end_tile;
  return &b->super;
}
