#include <stdio.h>
#include <stdlib.h>
#include <unicode/ubidi.h>
#include <unicode/ubrk.h>
#include <unicode/uchar.h>
#include <unicode/ucnv.h>
#include <unicode/unorm2.h>
#include <unicode/ustring.h>
static void check(UErrorCode e, const char *what) {
  if (U_FAILURE(e)) {
    fprintf(stderr, "%s: %s\n", what, u_errorName(e));
    exit(1);
  }
}
int main(void) {
  const char *locales[] = {"en", "fr", "ja", "zh", "zh_Hant", "ko",
                           "th", "lo", "km", "my", "ar",      "he"};
  const char *input =
      "Hello world. Café e\xcc\x81. 日本語の文章と中文测试。ภาษาไทยทดสอบ "
      "ພາສາລາວ ខ្មែរសាកល្បង မြန်မာစာ عربي עברית";
  UChar text[1024];
  int32_t len = 0;
  UErrorCode e = U_ZERO_ERROR;
  u_strFromUTF8(text, 1024, &len, input, -1, &e);
  check(e, "utf8");
  for (unsigned l = 0; l < sizeof(locales) / sizeof(locales[0]); l++) {
    e = U_ZERO_ERROR;
    UBreakIterator *b = ubrk_open(UBRK_LINE, locales[l], text, len, &e);
    check(e, locales[l]);
    printf("break %s:", locales[l]);
    for (int32_t i = ubrk_first(b); i != UBRK_DONE; i = ubrk_next(b))
      printf(" %d", i);
    puts("");
    ubrk_close(b);
  }
  e = U_ZERO_ERROR;
  UBiDi *b = ubidi_open();
  ubidi_setPara(b, text, len, UBIDI_DEFAULT_LTR, NULL, &e);
  check(e, "bidi");
  printf("bidi %d:", ubidi_getDirection(b));
  for (int32_t i = 0; i < len; i++)
    printf(" %d", ubidi_getLevelAt(b, i));
  puts("");
  ubidi_close(b);
  const char *encs[] = {"UTF-8",        "UTF-16BE",  "ISO-8859-1",
                        "windows-1252", "macintosh", "Shift_JIS",
                        "GB18030",      "Big5",      "EUC-KR",
                        "windows-1256", "IBM037"};
  for (unsigned i = 0; i < sizeof(encs) / sizeof(encs[0]); i++) {
    e = U_ZERO_ERROR;
    UConverter *c = ucnv_open(encs[i], &e);
    check(e, encs[i]);
    printf("converter %s %s\n", encs[i], ucnv_getName(c, &e));
    check(e, "converter-name");
    ucnv_close(c);
  }
  printf("converter count: %d\n", ucnv_countAvailable());
  e = U_ZERO_ERROR;
  const UNormalizer2 *n = unorm2_getNFKCInstance(&e);
  check(e, "NFKC");
  UChar normal[2048];
  int32_t nlen = unorm2_normalize(n, text, len, normal, 2048, &e);
  check(e, "normalization");
  printf("NFKC:");
  for (int32_t i = 0; i < nlen; i++)
    printf(" %04x", normal[i]);
  puts("");
  printf("properties:");
  for (int32_t i = 0; i < len; i++)
    printf(" %d", u_getIntPropertyValue(text[i], UCHAR_SCRIPT));
  puts("");
  return 0;
}
