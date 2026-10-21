# Compact preview renderer. Keep PDF, SVG, raster images, ICC color management,
# Base14 fonts and the smaller CJK fonts. TeX supplies document fonts.
html := no
xps := no
extract := no
archive := no
mujs := no
tesseract := no
barcode := no
tofu := yes
tofu_cjk_lang := yes

# Development builds use installed codecs; LCMS uses MuPDF's pinned submodule.
USE_SYSTEM_LIBS := yes
