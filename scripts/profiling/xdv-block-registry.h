/* Experiment-only provenance for imported-PDF drawing blocks. */
#ifndef TXP_XDV_BLOCK_REGISTRY_H
#define TXP_XDV_BLOCK_REGISTRY_H
#include <mupdf/fitz.h>
#include <stdint.h>
const char *txp_xdv_pdf_tag(void *document, int page, fz_matrix transform);
int txp_xdv_registered(const char *tag);
void txp_xdv_abort(const char *tag);
void txp_xdv_resource_changed(void);
#endif
