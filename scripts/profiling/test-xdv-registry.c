/* Standalone identity/registration checks; no engine or MuPDF library needed. */
#include "xdv-block-registry.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void copy_tag(char out[80], const char *tag)
{
  assert(tag != NULL);
  assert(strlen(tag) < 80);
  strcpy(out, tag);
}

int main(void)
{
  int document_a, document_b;
  const fz_matrix identity = {1, 0, 0, 1, 0, 0};
  fz_matrix moved = identity;
  moved.e = 0.125f;
  char original[80], changed[80], freed[80], aborted[80], evicted[80];
  copy_tag(original, txp_xdv_pdf_tag(&document_a, 0, identity));
  assert(txp_xdv_registered(original));
  assert(strcmp(original, txp_xdv_pdf_tag(&document_a, 0, identity)) == 0);
  assert(strcmp(original, txp_xdv_pdf_tag(&document_a, 1, identity)) != 0);
  assert(strcmp(original, txp_xdv_pdf_tag(&document_a, 0, moved)) != 0);
  assert(strcmp(original, txp_xdv_pdf_tag(&document_b, 0, identity)) != 0);
  char forged[80];
  assert(snprintf(forged, sizeof forged, "%s-forged", original) < (int)sizeof forged);
  assert(!txp_xdv_registered(forged));
  assert(!txp_xdv_registered("txp-xdv-forged-1"));
  assert(!txp_xdv_registered(NULL));
  assert(txp_xdv_pdf_tag(NULL, 0, identity) == NULL);

  /* Resource replacement and manager free use the same invalidation hook.
   * Reuse the exact address to exercise the allocator-ABA case directly. */
  txp_xdv_resource_changed();
  assert(!txp_xdv_registered(original));
  copy_tag(changed, txp_xdv_pdf_tag(&document_a, 0, identity));
  assert(strcmp(original, changed) != 0);
  txp_xdv_resource_changed();
  assert(!txp_xdv_registered(changed));
  copy_tag(freed, txp_xdv_pdf_tag(&document_a, 0, identity));
  assert(strcmp(changed, freed) != 0);

  txp_xdv_abort(freed);
  assert(!txp_xdv_registered(freed));
  copy_tag(aborted, txp_xdv_pdf_tag(&document_a, 0, identity));
  assert(strcmp(freed, aborted) != 0);
  txp_xdv_abort(NULL);
  txp_xdv_abort("txp-xdv-forged-1");
  assert(txp_xdv_registered(aborted));

  copy_tag(evicted, txp_xdv_pdf_tag(&document_a, 1000, identity));
  for (int page = 1001; page <= 1130; ++page) {
    const char *tag = txp_xdv_pdf_tag(&document_a, page, identity);
    assert(tag && txp_xdv_registered(tag));
  }
  assert(!txp_xdv_registered(evicted));
  const char *replacement = txp_xdv_pdf_tag(&document_a, 1000, identity);
  assert(replacement && txp_xdv_registered(replacement));
  assert(strcmp(evicted, replacement) != 0);
  assert(!txp_xdv_registered(evicted));
  puts("XDV block registry assertions passed");
  return 0;
}
