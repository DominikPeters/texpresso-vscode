/* Measurement-only conservative cell fingerprints. Injected into a scratch
 * preview.c by build-damage-engine.cjs; never linked into a shipping bundle.
 *
 * Supported ink: paths and non-Type-3 text, including clips and groups. Unsupported
 * images, shadings, masks, patterns and default-color changes force a full draw.
 * Drawing order and all clip/group state events enter each cell's SHA-256 stream.
 * Old display lists stay alive while fingerprints are compared, so immutable
 * font/colorspace pointer identity cannot be confused by allocator reuse.
 * Full-reference validation is mandatory: this is an experiment, not a proof
 * that MuPDF bounds cover every possible raster effect. */
#include <stddef.h>
#include <stdlib.h>

typedef struct {
  fz_display_list *list;
  int id, page, width, nx, ny, supported;
  unsigned unsupported;
  int block_hits, block_misses, cached_operations;
  fz_irect clip;
  fz_rect bounds;
  txp_renderer_config config;
  unsigned char *keys;
} damage_snapshot;
typedef struct {
  fz_device super;
  damage_snapshot *snapshot;
  fz_sha256 *cells, op;
  const txp_preview_grid *grid;
  fz_matrix matrix;
  int operations, global_op;
} damage_device;
static damage_snapshot damage_history[TXP_PREVIEW_RETAINED];
static unsigned damage_clock;

#define D_BYTES(d, p, n) fz_sha256_update(&(d)->op, (const unsigned char *)(p), (n))
#define D_FIELD(d, v) D_BYTES(d, &(v), sizeof(v))
static void d_begin(damage_device *d, int kind) { fz_sha256_init(&d->op); D_FIELD(d,kind); d->operations++; d->global_op=0; }
static void d_color(fz_context *ctx, damage_device *d, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp)
{
  D_FIELD(d,cs); D_FIELD(d,alpha);
  unsigned params[]={cp.ri,cp.bp,cp.op,cp.opm}; D_BYTES(d,params,sizeof params);
  if(cs && color) D_BYTES(d,color,sizeof(float)*fz_colorspace_n(ctx,cs));
}
static void d_stroke(damage_device *d, const fz_stroke_state *s)
{
  D_FIELD(d,s->start_cap); D_FIELD(d,s->end_cap); D_FIELD(d,s->dash_cap); D_FIELD(d,s->linejoin);
  D_FIELD(d,s->linewidth); D_FIELD(d,s->miterlimit); D_FIELD(d,s->dash_phase); D_FIELD(d,s->dash_len);
  D_BYTES(d,s->dash_list,sizeof(float)*s->dash_len);
}
static void d_move(fz_context *ctx,void *arg,float x,float y)
{ damage_device *d=arg; int op=1; D_FIELD(d,op); D_FIELD(d,x); D_FIELD(d,y); }
static void d_line(fz_context *ctx,void *arg,float x,float y)
{ damage_device *d=arg; int op=2; D_FIELD(d,op); D_FIELD(d,x); D_FIELD(d,y); }
static void d_curve(fz_context *ctx,void *arg,float x1,float y1,float x2,float y2,float x3,float y3)
{ damage_device *d=arg; int op=3; float p[]={x1,y1,x2,y2,x3,y3}; D_FIELD(d,op); D_BYTES(d,p,sizeof p); }
static void d_close(fz_context *ctx,void *arg)
{ damage_device *d=arg; int op=4; D_FIELD(d,op); }
static void d_path(fz_context *ctx,damage_device *d,const fz_path *path)
{
  static const fz_path_walker walker={.moveto=d_move,.lineto=d_line,.curveto=d_curve,.closepath=d_close};
  fz_walk_path(ctx,path,&walker,d);
}
static void d_text(fz_context *ctx,damage_device *d,const fz_text *text)
{
  for(const fz_text_span *s=text->head;s;s=s->next) {
    // Type 3 programs can paint outside declared glyph bounds. Their exact
    // operation signature conservatively participates in EVERY cell.
    if(fz_font_t3_procs(ctx,s->font)) d->global_op=1;
    D_FIELD(d,s->font); D_FIELD(d,s->trm); D_FIELD(d,s->len);
    unsigned flags[]={s->wmode,s->bidi_level,s->markup_dir,s->language}; D_BYTES(d,flags,sizeof flags);
    // Only fields used by rasterization; unicode/cid/adv are semantic metadata.
    for(int i=0;i<s->len;i++) { D_FIELD(d,s->items[i].x); D_FIELD(d,s->items[i].y); D_FIELD(d,s->items[i].gid); }
  }
}
static void d_finish(damage_device *d, fz_rect bounds, int state)
{
  unsigned char digest[32]; fz_sha256_final(&d->op,digest);
  damage_snapshot *s=d->snapshot;
  state=state || d->global_op;
  if(!state) {
    bounds=fz_transform_rect(bounds,d->matrix);
    // Include antialias fringe and rounding outside analytic drawing bounds.
    bounds=fz_expand_rect(bounds,2);
    if(!isfinite(bounds.x0)||!isfinite(bounds.y0)||!isfinite(bounds.x1)||!isfinite(bounds.y1)) { s->supported=0; return; }
  }
  for(int y=0;y<s->ny;y++)for(int x=0;x<s->nx;x++) {
    int left=(s->clip.x0/TXP_PREVIEW_CELL+x)*TXP_PREVIEW_CELL;
    int top=(s->clip.y0/TXP_PREVIEW_CELL+y)*TXP_PREVIEW_CELL;
    if(state || (bounds.x0<left+TXP_PREVIEW_CELL && bounds.x1>=left && bounds.y0<top+TXP_PREVIEW_CELL && bounds.y1>=top))
      fz_sha256_update(&d->cells[y*s->nx+x],digest,sizeof digest);
  }
}
static void d_fill_path(fz_context *ctx,fz_device *dev,const fz_path *p,int eo,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp)
{ damage_device *d=(void*)dev; d_begin(d,1); D_FIELD(d,m); D_FIELD(d,eo); d_color(ctx,d,cs,c,a,cp); d_path(ctx,d,p); d_finish(d,fz_bound_path(ctx,p,NULL,m),0); }
static void d_stroke_path(fz_context *ctx,fz_device *dev,const fz_path *p,const fz_stroke_state *s,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp)
{ damage_device *d=(void*)dev; d_begin(d,2); D_FIELD(d,m); d_stroke(d,s); d_color(ctx,d,cs,c,a,cp); d_path(ctx,d,p); d_finish(d,fz_bound_path(ctx,p,s,m),0); }
static void d_fill_text(fz_context *ctx,fz_device *dev,const fz_text *t,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp)
{ damage_device *d=(void*)dev; d_begin(d,3); D_FIELD(d,m); d_color(ctx,d,cs,c,a,cp); d_text(ctx,d,t); d_finish(d,fz_bound_text(ctx,t,NULL,m),0); }
static void d_stroke_text(fz_context *ctx,fz_device *dev,const fz_text *t,const fz_stroke_state *s,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp)
{ damage_device *d=(void*)dev; d_begin(d,4); D_FIELD(d,m); d_stroke(d,s); d_color(ctx,d,cs,c,a,cp); d_text(ctx,d,t); d_finish(d,fz_bound_text(ctx,t,s,m),0); }
static void d_clip_path(fz_context *ctx,fz_device *dev,const fz_path *p,int eo,fz_matrix m,fz_rect r)
{ damage_device *d=(void*)dev; d_begin(d,5); D_FIELD(d,m); D_FIELD(d,eo); D_FIELD(d,r); d_path(ctx,d,p); d_finish(d,r,1); }
static void d_clip_stroke(fz_context *ctx,fz_device *dev,const fz_path *p,const fz_stroke_state *s,fz_matrix m,fz_rect r)
{ damage_device *d=(void*)dev; d_begin(d,6); D_FIELD(d,m); D_FIELD(d,r); d_stroke(d,s); d_path(ctx,d,p); d_finish(d,r,1); }
static void d_clip_text(fz_context *ctx,fz_device *dev,const fz_text *t,fz_matrix m,fz_rect r)
{ damage_device *d=(void*)dev; d_begin(d,7); D_FIELD(d,m); D_FIELD(d,r); d_text(ctx,d,t); d_finish(d,r,1); }
static void d_clip_stroke_text(fz_context *ctx,fz_device *dev,const fz_text *t,const fz_stroke_state *s,fz_matrix m,fz_rect r)
{ damage_device *d=(void*)dev; d_begin(d,8); D_FIELD(d,m); D_FIELD(d,r); d_stroke(d,s); d_text(ctx,d,t); d_finish(d,r,1); }
static void d_pop(fz_context *ctx,fz_device *dev)
{ damage_device *d=(void*)dev; d_begin(d,9); d_finish(d,fz_empty_rect,1); }
static void d_group(fz_context *ctx,fz_device *dev,fz_rect r,fz_colorspace *cs,int isolated,int knockout,int blend,float alpha)
{ damage_device *d=(void*)dev; d_begin(d,10); D_FIELD(d,r); D_FIELD(d,cs); D_FIELD(d,isolated); D_FIELD(d,knockout); D_FIELD(d,blend); D_FIELD(d,alpha); d_finish(d,r,1); }
static void d_end_group(fz_context *ctx,fz_device *dev)
{ damage_device *d=(void*)dev; d_begin(d,11); d_finish(d,fz_empty_rect,1); }
static void d_flags(fz_context *ctx,fz_device *dev,int set,int clear)
{ damage_device *d=(void*)dev; d_begin(d,12); D_FIELD(d,set); D_FIELD(d,clear); d_finish(d,fz_empty_rect,1); }
// These operators are deliberately unclassified: no reuse of any cells.
static void d_shade(fz_context *ctx,fz_device *dev,fz_shade *s,fz_matrix m,float a,fz_color_params cp) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=1; }
static void d_image(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,float a,fz_color_params cp) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=2; }
static void d_image_mask(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,fz_colorspace *cs,const float *c,float a,fz_color_params cp) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=4; }
static void d_clip_image(fz_context *ctx,fz_device *dev,fz_image *i,fz_matrix m,fz_rect r) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=4; }
static void d_mask(fz_context *ctx,fz_device *dev,fz_rect r,int lum,fz_colorspace *cs,const float *c,fz_color_params cp) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=8; }
static void d_end_mask(fz_context *ctx,fz_device *dev,fz_function *fn) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=8; ((damage_device*)dev)->snapshot->unsupported|=8; }
static int d_tile(fz_context *ctx,fz_device *dev,fz_rect r,fz_rect v,float x,float y,fz_matrix m,int id,int doc) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=16; return 0; }
static void d_end_tile(fz_context *ctx,fz_device *dev) { ((damage_device*)dev)->snapshot->supported=0; ((damage_device*)dev)->snapshot->unsupported|=16; ((damage_device*)dev)->snapshot->unsupported|=16; }
static void d_defaults(fz_context *ctx,fz_device *dev,fz_default_colorspaces *cs)
{
  damage_device *d=(void*)dev; d_begin(d,13);
  fz_colorspace *spaces[]={cs?fz_default_gray(ctx,cs):NULL,cs?fz_default_rgb(ctx,cs):NULL,
    cs?fz_default_cmyk(ctx,cs):NULL,cs?fz_default_output_intent(ctx,cs):NULL};
  D_BYTES(d,spaces,sizeof spaces); d_finish(d,fz_empty_rect,1);
}

#ifdef TXP_XDV_BLOCKS
#include "xdv-block-damage.h"
#endif

static void damage_drop(fz_context *ctx,damage_snapshot *s)
{ fz_drop_display_list(ctx,s->list); fz_free(ctx,s->keys); *s=(damage_snapshot){0}; }
static damage_snapshot damage_analyze(fz_context *ctx,txp_preview *p,fz_display_list *list,fz_rect page,const txp_preview_grid *grid,fz_irect clip,txp_renderer_config *config,int *operations)
{
  damage_snapshot s={.id=p->request,.page=p->page,.width=grid->width,.clip=clip,.bounds=page,.config=*config,.supported=1};
  s.nx=(clip.x1+TXP_PREVIEW_CELL-1)/TXP_PREVIEW_CELL-clip.x0/TXP_PREVIEW_CELL;
  s.ny=(clip.y1+TXP_PREVIEW_CELL-1)/TXP_PREVIEW_CELL-clip.y0/TXP_PREVIEW_CELL;
  damage_device *d=NULL; fz_var(d);
  fz_device *proxy=NULL; fz_var(proxy);
  fz_try(ctx) {
    s.list=fz_keep_display_list(ctx,list); s.keys=fz_malloc(ctx,(size_t)s.nx*s.ny*32);
    d=fz_new_derived_device(ctx,damage_device); d->snapshot=&s; d->grid=grid; d->matrix=grid_matrix(page,grid);
    d->cells=fz_calloc(ctx,(size_t)s.nx*s.ny,sizeof(fz_sha256));
    for(int i=0;i<s.nx*s.ny;i++)fz_sha256_init(&d->cells[i]);
    d->super.fill_path=d_fill_path; d->super.stroke_path=d_stroke_path; d->super.fill_text=d_fill_text; d->super.stroke_text=d_stroke_text;
    d->super.clip_path=d_clip_path; d->super.clip_stroke_path=d_clip_stroke; d->super.clip_text=d_clip_text; d->super.clip_stroke_text=d_clip_stroke_text;
    d->super.pop_clip=d_pop; d->super.begin_group=d_group; d->super.end_group=d_end_group; d->super.render_flags=d_flags;
    d->super.fill_shade=d_shade; d->super.fill_image=d_image; d->super.fill_image_mask=d_image_mask; d->super.clip_image_mask=d_clip_image;
    d->super.begin_mask=d_mask; d->super.end_mask=d_end_mask; d->super.begin_tile=d_tile; d->super.end_tile=d_end_tile; d->super.set_default_colorspaces=d_defaults;
    #ifdef TXP_XDV_BLOCKS
    proxy=block_proxy(ctx,d);
#else
    proxy=fz_keep_device(ctx,&d->super);
#endif
    fz_run_display_list(ctx,list,proxy,fz_identity,fz_infinite_rect,NULL); fz_close_device(ctx,proxy);
    for(int i=0;i<s.nx*s.ny;i++)fz_sha256_final(&d->cells[i],s.keys+i*32);
    *operations=d->operations;
  }
  fz_always(ctx) { fz_drop_device(ctx,proxy); if(d)fz_free(ctx,d->cells); fz_drop_device(ctx,(fz_device*)d); }
  fz_catch(ctx) { damage_drop(ctx,&s); fz_rethrow(ctx); }
  return s;
}

/* Replay one canonical cell into the cloned destination when the held rectangle
 * contains it completely. Partial cells still rasterize the entire canonical
 * cell before copying: changing MuPDF's raster bounds can change path AA. */
static int damage_redraw_cell(fz_context *ctx,fz_display_list *list,fz_rect page,
                             const txp_preview_grid *grid,fz_irect clip,fz_irect whole,
                             fz_pixmap *pix,txp_renderer *renderer)
{
  fz_irect part=fz_intersect_irect(whole,clip);
  int direct=part.x0==whole.x0 && part.y0==whole.y0 && part.x1==whole.x1 && part.y1==whole.y1;
  fz_pixmap *view=NULL;fz_device *dev=NULL;
  fz_var(view);fz_var(dev);
  fz_try(ctx) {
    if(direct) {
      view=fz_new_pixmap_with_data(ctx,fz_device_rgb(ctx),whole.x1-whole.x0,whole.y1-whole.y0,NULL,0,
        pix->stride,pix->samples+(size_t)(whole.y0-clip.y0)*pix->stride+(size_t)(whole.x0-clip.x0)*3);
      view->x=whole.x0;view->y=whole.y0;
    } else view=fz_new_pixmap_with_bbox(ctx,fz_device_rgb(ctx),whole,NULL,0);
    /* The view shares a larger stride: clear its pixels, never adjacent cells
     * or row padding. Retained pixels have already been colorized. */
    for(int row=0;row<view->h;row++)memset(view->samples+(size_t)row*view->stride,255,(size_t)view->w*3);
    dev=fz_new_draw_device(ctx,fz_identity,view);
    fz_run_display_list(ctx,list,dev,grid_matrix(page,grid),fz_rect_from_irect(whole),NULL);
    fz_close_device(ctx,dev);fz_drop_device(ctx,dev);dev=NULL;
    txp_renderer_colorize_rgb(ctx,renderer,view);
    if(!direct)for(int row=part.y0;row<part.y1;row++)
      memcpy(pix->samples+(size_t)(row-clip.y0)*pix->stride+(size_t)(part.x0-clip.x0)*3,
        view->samples+(size_t)(row-whole.y0)*view->stride+(size_t)(part.x0-whole.x0)*3,
        (size_t)(part.x1-part.x0)*3);
  }
  fz_always(ctx) {fz_drop_device(ctx,dev);fz_drop_pixmap(ctx,view);}
  fz_catch(ctx)fz_rethrow(ctx);
  return direct;
}

static fz_pixmap *damage_draw(fz_context *ctx,txp_preview *p,fz_display_list *list,fz_rect page,const txp_preview_grid *grid,fz_irect clip,txp_renderer *renderer)
{
  if(!p->surface)return txp_preview_draw(ctx,list,page,grid,clip);
  double start=txp_profile_now(); int operations=0;
  txp_renderer_config *config=txp_renderer_get_config(ctx,renderer);
  damage_snapshot next=damage_analyze(ctx,p,list,page,grid,clip,config,&operations),*old=NULL;
  for(int i=0;i<TXP_PREVIEW_RETAINED;i++)if(damage_history[i].id==p->patch_base && p->patch_base>0)old=&damage_history[i];
  txp_preview_raster *base=txp_preview_retained(p,p->patch_base);
  int reuse=old && base && old->supported && next.supported && old->page==next.page && old->width==next.width &&
    !memcmp(&old->clip,&clip,sizeof clip) && !memcmp(&old->bounds,&page,sizeof page) &&
    old->config.foreground_color==config->foreground_color && old->config.background_color==config->background_color &&
    old->config.themed_color==config->themed_color && old->config.invert_color==config->invert_color;
  double analysis=txp_profile_now()-start,draw_start=txp_profile_now();
  fz_pixmap *pix=NULL,*part=NULL,*reference=NULL;
  const char *direct_env=getenv("TEXPRESSO_DAMAGE_DIRECT");
  int direct=direct_env && !strcmp(direct_env,"1"),direct_cells=0;
  int changed=0,total=next.nx*next.ny; fz_var(pix); fz_var(part); fz_var(reference);
  fz_try(ctx) {
    if(!reuse) { pix=txp_preview_draw(ctx,list,page,grid,clip); changed=total; }
    else {
      // Retained pixels are colorized. Clone once, replay all contributing ink
      // in changed canonical cells, then colorize those cells only. The caller
      // must not colorize the result for a second time (scratch hook handles it).
      if(!base->pixels->samples || base->pixels->w!=clip.x1-clip.x0 || base->pixels->h!=clip.y1-clip.y0 || base->pixels->n!=3)
        fz_throw(ctx,FZ_ERROR_GENERIC,"Experimental base geometry mismatch");
      pix=fz_new_pixmap_with_bbox(ctx,fz_device_rgb(ctx),clip,NULL,0);
      for(int row=0;row<pix->h;row++)memcpy(pix->samples+(size_t)row*pix->stride,
        base->pixels->samples+(size_t)row*base->pixels->stride,(size_t)pix->w*3);
      for(int y=0;y<next.ny;y++)for(int x=0;x<next.nx;x++) {
        int i=y*next.nx+x;
        if(!memcmp(old->keys+i*32,next.keys+i*32,32))continue;
        changed++;
        fz_irect cell={(clip.x0/TXP_PREVIEW_CELL+x)*TXP_PREVIEW_CELL,(clip.y0/TXP_PREVIEW_CELL+y)*TXP_PREVIEW_CELL,0,0};
        cell.x1=fz_mini(cell.x0+TXP_PREVIEW_CELL,grid->width);cell.y1=fz_mini(cell.y0+TXP_PREVIEW_CELL,grid->height);
        if(direct)direct_cells+=damage_redraw_cell(ctx,list,page,grid,clip,cell,pix,renderer);
        else {
          cell=fz_intersect_irect(cell,clip);
          part=txp_preview_draw(ctx,list,page,grid,cell);txp_renderer_colorize_rgb(ctx,renderer,part);
          for(int row=cell.y0;row<cell.y1;row++)memcpy(pix->samples+(size_t)(row-clip.y0)*pix->stride+(cell.x0-clip.x0)*3,
            part->samples+(size_t)(row-cell.y0)*part->stride,(size_t)(cell.x1-cell.x0)*3);
          fz_drop_pixmap(ctx,part);part=NULL;
        }
      }
    }
    if(!reuse)txp_renderer_colorize_rgb(ctx,renderer,pix);
    double render=txp_profile_now()-draw_start;
    // Verification is deliberately outside the measured analysis/replay stages.
    // It runs on EVERY export, not a sample. False-negative damage aborts.
    double reference_start=txp_profile_now();
    reference=txp_preview_draw(ctx,list,page,grid,clip);txp_renderer_colorize_rgb(ctx,renderer,reference);
    for(int y=0;y<pix->h;y++)if(memcmp(pix->samples+(size_t)y*pix->stride,reference->samples+(size_t)y*reference->stride,(size_t)pix->w*3))
      fz_throw(ctx,FZ_ERROR_GENERIC,"Experimental damage missed changed sharp pixels");
    double reference_ms=txp_profile_now()-reference_start;
    fprintf(stderr,"[damage] {\"request\":%d,\"analysisMs\":%.6f,\"renderMs\":%.6f,\"referenceMs\":%.6f,\"changedCells\":%d,\"totalCells\":%d,\"operations\":%d,\"supported\":%s,\"unsupported\":%u,\"reused\":%s,\"direct\":%s,\"directCells\":%d,\"blockHits\":%d,\"blockMisses\":%d,\"cachedOperations\":%d,\"exact\":true}\n",
      p->request,analysis,render,reference_ms,changed,total,operations,next.supported?"true":"false",next.unsupported,reuse?"true":"false",direct?"true":"false",direct_cells,next.block_hits,next.block_misses,next.cached_operations);
    unsigned slot=damage_clock++%TXP_PREVIEW_RETAINED;damage_drop(ctx,&damage_history[slot]);damage_history[slot]=next;next=(damage_snapshot){0};
  }
  fz_always(ctx) { fz_drop_pixmap(ctx,reference);fz_drop_pixmap(ctx,part);damage_drop(ctx,&next); }
  fz_catch(ctx) { fz_drop_pixmap(ctx,pix);fz_rethrow(ctx); }
  return pix;
}
