FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Build tools + libopus support the native Opus encoder; opusscript is a fallback.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ libopus-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./server.js
COPY src ./src
COPY public ./public

EXPOSE 3000 8765
CMD ["node", "server.js"]
