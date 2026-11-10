FROM node:26-alpine AS build-stage

# Node 25 and later no longer ship corepack, so pnpm comes from npm. npm leaves
# pnpm's install scripts unrun; its bins then start through Node.js, which is fine here.
RUN apk add --no-cache python3 make g++ && \
    npm install --global pnpm@12.18.0

WORKDIR /tmp/build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./

RUN pnpm install --frozen-lockfile

COPY . .

ARG COMMIT_SHA
RUN echo "COMMIT_SHA=${COMMIT_SHA:-Unknown}" > /tmp/build/.env.build
RUN pnpm build
RUN pnpm prune --production

FROM node:26-alpine

LABEL name="rawon-libre"
LABEL maintainer="hang333 <jonathan.goh333@gmail.com>"
LABEL org.opencontainers.image.source="https://github.com/hang333/rawon-libre"
LABEL org.opencontainers.image.licenses="AGPL-3.0"
LABEL org.opencontainers.image.description="The AGPL-3.0 community continuation of Rawon."

WORKDIR /app

RUN apk add --no-cache \
        ffmpeg python3 \
        chromium nss freetype harfbuzz ca-certificates ttf-freefont && \
    ln -sf python3 /usr/bin/python && \
    mkdir -p /app/cache /app/cache/cookies/browser-profile

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY --from=build-stage /tmp/build/package.json ./
COPY --from=build-stage /tmp/build/node_modules ./node_modules
COPY --from=build-stage /tmp/build/dist ./dist
COPY --from=build-stage /tmp/build/src/utils/yt-dlp ./src/utils/yt-dlp
COPY --from=build-stage /tmp/build/lang ./lang
COPY --from=build-stage /tmp/build/index.js ./index.js
COPY --from=build-stage /tmp/build/.env.build ./

ENV NODE_ENV=production

EXPOSE 3000

RUN echo '#!/bin/sh' > /app/entrypoint.sh && \
    echo 'set -a' >> /app/entrypoint.sh && \
    echo '[ -f .env.build ] && . ./.env.build' >> /app/entrypoint.sh && \
    echo 'set +a' >> /app/entrypoint.sh && \
    echo 'exec node --es-module-specifier-resolution=node index.js' >> /app/entrypoint.sh && \
    chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
