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
      xvfb x11vnc fluxbox xterm dbus-x11 x11-xserver-utils fonts-dejavu-core \
      python3 python3-pip make g++ \
    && rm -rf /var/lib/apt/lists/*

# Debian marks the system Python as "externally managed" (PEP 668), which
# blocks plain `pip install`. This is a single-user scratch container, not a
# shared system, so let pip install into it directly.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "server.js"]
