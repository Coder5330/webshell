# App container for Render's Docker-runtime service (not Docker-in-Docker —
# just a normal container that Render builds and runs). Unrelated to
# Dockerfile.sandbox, which builds the per-session MODE=docker sandbox image
# and is irrelevant here since Render has no Docker daemon of its own.
#
# This image adds a virtual display (Xvfb) + window manager (fluxbox) +
# VNC server (x11vnc) so GUI scripts (e.g. pynput/pygame) run via MODE=local
# have something real to draw to, streamed into the browser over noVNC.

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils grep sed gawk findutils \
      less nano vim tmux \
      python3 python3-pip python3-venv build-essential \
      netcat-openbsd file tree curl wget git openssh-client ca-certificates \
      binutils gdb \
      binwalk libimage-exiftool-perl steghide foremost bsdmainutils xxd \
      unzip zip p7zip-full bzip2 xz-utils \
      dnsutils nmap jq \
      xvfb x11vnc fluxbox xterm dbus-x11 x11-xserver-utils fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Package groups above, for reference:
#   shell/core:      bash coreutils grep sed gawk findutils
#   editors:         less nano vim tmux
#   python/build:    python3 python3-pip python3-venv build-essential (also
#                    satisfies node-pty's node-gyp native build requirement)
#   networking/dev:  netcat-openbsd file tree curl wget git openssh-client ca-certificates
#   reversing:       binutils gdb
#   forensics/stego: binwalk libimage-exiftool-perl steghide foremost bsdmainutils xxd
#   archives:        unzip zip p7zip-full bzip2 xz-utils
#   networking tools: dnsutils nmap jq
#   virtual desktop: xvfb x11vnc fluxbox xterm dbus-x11 x11-xserver-utils fonts-dejavu-core

# Debian marks the system Python as "externally managed" (PEP 668), which
# blocks plain `pip install`. This is a single-user scratch container, not a
# shared system, so let pip install into it directly.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "server.js"]
