FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Install litestream (pinned) for continuous SQLite replication to R2
ARG LITESTREAM_VERSION=0.3.13
RUN wget -q https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz \
    && tar -C /usr/local/bin -xzf litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz \
    && rm litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz \
    && litestream version

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3750

EXPOSE 3750

# Restore (if replica exists) then replicate while running the server.
# `-if-replica-exists` is a no-op on first boot when no backup is present.
CMD ["sh", "-c", "litestream restore -if-replica-exists -config /app/litestream.yml /data/maestro.db || true; exec litestream replicate -exec 'node server.js' -config /app/litestream.yml"]
