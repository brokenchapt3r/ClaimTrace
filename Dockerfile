FROM node:20-bookworm AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG VITE_CLAIMTRACE_TENANT_ID=local-user
ARG VITE_CLAIMTRACE_DATASET_ID=claimtrace-default
ARG VITE_CLAIMTRACE_DATASET_NAME=Default Knowledge Base
ARG VITE_CLAIMTRACE_CHAT_MODEL=qwen3:8b
ARG VITE_CLAIMTRACE_CHAT_MODEL_ID=qwen3:8b@API
ENV VITE_CLAIMTRACE_TENANT_ID=$VITE_CLAIMTRACE_TENANT_ID \
    VITE_CLAIMTRACE_DATASET_ID=$VITE_CLAIMTRACE_DATASET_ID \
    VITE_CLAIMTRACE_DATASET_NAME=$VITE_CLAIMTRACE_DATASET_NAME \
    VITE_CLAIMTRACE_CHAT_MODEL=$VITE_CLAIMTRACE_CHAT_MODEL \
    VITE_CLAIMTRACE_CHAT_MODEL_ID=$VITE_CLAIMTRACE_CHAT_MODEL_ID
RUN npm test && npm run type-check && npm run build

FROM node:20-bookworm AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm test && npm run type-check && npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CLAIMTRACE_PUBLIC_DIR=/app/public
WORKDIR /app
RUN groupadd --system --gid 10001 claimtrace \
    && useradd --system --uid 10001 --gid claimtrace --home /app claimtrace \
    && mkdir -p /var/lib/claimtrace /app/public \
    && chown -R claimtrace:claimtrace /var/lib/claimtrace /app
COPY --from=server-build --chown=claimtrace:claimtrace /build/server/dist ./dist
COPY --from=server-build --chown=claimtrace:claimtrace /build/server/node_modules ./node_modules
COPY --from=server-build --chown=claimtrace:claimtrace /build/server/package.json ./package.json
COPY --from=web-build --chown=claimtrace:claimtrace /build/web/dist ./public
USER claimtrace
EXPOSE 9222
CMD ["node", "dist/index.js"]
