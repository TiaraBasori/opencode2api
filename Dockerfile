FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')" \
    && curl -Lo /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.17/gosu-$dpkgArch" \
    && chmod +x /usr/local/bin/gosu \
    && gosu --version \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

RUN mkdir -p /home/node/.local/share/opencode \
    && mkdir -p /home/node/.config/opencode \
    && mkdir -p /home/node/project \
    && chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/node/project

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 10000 10001

ENV OPENCODE_SERVER_PASSWORD=
ENV API_KEY=
ENV BIND_HOST=0.0.0.0
ENV DISABLE_TOOLS=true
ENV OPENCODE_USE_ISOLATED_HOME=false
ENV OPENCODE_PROXY_DEBUG=false
ENV OPENCODE_PROXY_PROMPT_MODE=standard
ENV OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=false
ENV OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=false
ENV OPENCODE_PROXY_CLEANUP_INTERVAL_MS=43200000
ENV OPENCODE_PROXY_CLEANUP_MAX_AGE_MS=86400000
ENV OPENCODE_PROXY_REQUEST_TIMEOUT_MS=180000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "10001"]
