FROM node:20-bookworm-slim

# better-sqlite3 compiles from source when no arm64 prebuild matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME ["/data"]

CMD ["node", "src/index.js"]
