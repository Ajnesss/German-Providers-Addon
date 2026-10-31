FROM node:22-bookworm-slim
WORKDIR /app
# Cloudflare WARP tools (amd64 on Render, arm64 on Oracle's free Ampere servers) (optional: if a download fails the addon still runs without WARP)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && ARCH=$(dpkg --print-architecture) \
 && (curl -fsSL -o /usr/local/bin/wgcf https://github.com/ViRb3/wgcf/releases/download/v2.3.1/wgcf_2.3.1_linux_${ARCH} \
     && chmod +x /usr/local/bin/wgcf || echo "wgcf download failed") \
 && (mkdir -p /tmp/wp && curl -fsSL https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_${ARCH}.tar.gz | tar -xz -C /tmp/wp \
     && find /tmp/wp -type f -name wireproxy -exec mv {} /usr/local/bin/wireproxy \; && chmod +x /usr/local/bin/wireproxy || echo "wireproxy download failed") \
 && rm -rf /tmp/wp /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "start.sh"]
