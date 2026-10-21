/* Offline display-list export experiment; not part of the extension runtime. */
#include <mupdf/fitz.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static double now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(int argc, char **argv)
{
    if (argc != 5) {
        fprintf(stderr, "usage: preview PDF PIXEL_WIDTH REPEATS OUTPUT_PREFIX\n");
        return 2;
    }
    int width = atoi(argv[2]), repeats = atoi(argv[3]);
    if (width < 1 || width > 4096 || repeats < 1 || repeats > 100)
        return 2;
    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_DEFAULT);
    if (!ctx) return 1;
    fz_document *doc = NULL;
    fz_display_list *list = NULL;
    fz_pixmap *pix = NULL;
    fz_buffer *buf = NULL;
    fz_output *out = NULL;
    fz_device *dev = NULL;
    int status = 0;
    fz_var(doc); fz_var(list); fz_var(pix); fz_var(buf);
    fz_var(out); fz_var(dev); fz_var(status);
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        double start = now_ms();
        doc = fz_open_document(ctx, argv[1]);
        if (fz_count_pages(ctx, doc) != 1)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "fixture must contain exactly one page");
        list = fz_new_display_list_from_page_number(ctx, doc, 0);
        double load = now_ms() - start;
        fz_rect bounds = fz_bound_display_list(ctx, list);
        float scale = width / (bounds.x1 - bounds.x0);
        double draw = 0, png = 0, svg = 0;
        size_t png_bytes = 0, svg_bytes = 0, rgb_bytes = 0;
        int height = 0;
        /* One untimed warm-up, then repeated exports of the same display list. */
        for (int i = -1; i < repeats; ++i) {
            start = now_ms();
            pix = fz_new_pixmap_from_display_list(ctx, list, fz_scale(scale, scale),
                                                 fz_device_rgb(ctx), 0);
            double drawn = now_ms();
            buf = fz_new_buffer_from_pixmap_as_png(ctx, pix, fz_default_color_params);
            double encoded = now_ms();
            png_bytes = fz_buffer_storage(ctx, buf, NULL);
            height = fz_pixmap_height(ctx, pix);
            rgb_bytes = (size_t)fz_pixmap_stride(ctx, pix) * height;
            if (i >= 0) { draw += drawn - start; png += encoded - drawn; }
            if (i == repeats - 1) {
                char name[4096];
                snprintf(name, sizeof name, "%s.png", argv[4]);
                fz_save_buffer(ctx, buf, name);
            }
            fz_drop_buffer(ctx, buf); buf = NULL;
            fz_drop_pixmap(ctx, pix); pix = NULL;

            start = now_ms();
            buf = fz_new_buffer(ctx, 0);
            out = fz_new_output_with_buffer(ctx, buf);
            dev = fz_new_svg_device(ctx, out, bounds.x1 - bounds.x0,
                                    bounds.y1 - bounds.y0, FZ_SVG_TEXT_AS_PATH, 1);
            fz_run_display_list(ctx, list, dev, fz_translate(-bounds.x0, -bounds.y0),
                                fz_infinite_rect, NULL);
            fz_close_device(ctx, dev);
            fz_close_output(ctx, out);
            double serialized = now_ms();
            if (i >= 0) svg += serialized - start;
            svg_bytes = fz_buffer_storage(ctx, buf, NULL);
            if (i == repeats - 1) {
                char name[4096];
                snprintf(name, sizeof name, "%s.svg", argv[4]);
                fz_save_buffer(ctx, buf, name);
            }
            fz_drop_device(ctx, dev); dev = NULL;
            fz_drop_output(ctx, out); out = NULL;
            fz_drop_buffer(ctx, buf); buf = NULL;
        }
        printf("{\"width\":%d,\"height\":%d,\"repeats\":%d,"
               "\"load_list_ms\":%.3f,\"png_draw_ms\":%.3f,\"png_encode_ms\":%.3f,"
               "\"svg_export_ms\":%.3f,\"png_bytes\":%zu,\"svg_bytes\":%zu,"
               "\"native_rgb_bytes\":%zu}\n", width, height, repeats, load,
               draw/repeats, png/repeats, svg/repeats, png_bytes, svg_bytes, rgb_bytes);
    }
    fz_always(ctx) {
        fz_drop_device(ctx, dev);
        fz_drop_output(ctx, out);
        fz_drop_buffer(ctx, buf);
        fz_drop_pixmap(ctx, pix);
        fz_drop_display_list(ctx, list);
        fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        fprintf(stderr, "%s\n", fz_caught_message(ctx));
        status = 1;
    }
    fz_drop_context(ctx);
    return status;
}
