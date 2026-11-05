# Experimental portable builder. Images and all substantial builds stay in CI.
FROM almalinux:8
RUN dnf -y install dnf-plugins-core epel-release \
 && dnf config-manager --set-enabled powertools \
 && dnf -y --setopt=install_weak_deps=False install \
      git ca-certificates curl make cmake pkgconf-pkg-config patchelf binutils \
      gcc-toolset-13-gcc gcc-toolset-13-gcc-c++ python3.12 \
      freetype-devel libjpeg-turbo-devel openjpeg2-devel brotli-devel SDL2-devel \
      harfbuzz-devel graphite2-devel fontconfig-devel libpng-devel jbig2dec-devel \
 && ln -s /usr/bin/python3.12 /usr/local/bin/python3 \
 && dnf clean all
ENV PATH=/opt/rh/gcc-toolset-13/root/usr/bin:/usr/local/bin:/usr/bin:/bin
ENV SDL_VIDEODRIVER=dummy
