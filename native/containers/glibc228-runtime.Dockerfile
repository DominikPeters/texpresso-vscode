# Runtime libraries and an old-glibc kpathsea binary; no compiler/devel packages.
FROM almalinux:8
RUN dnf -y --setopt=install_weak_deps=False install \
      texlive-xetex texlive-latex texlive-lm libstdc++ \
 && dnf clean all
