FROM node:20.20.2-slim AS build

WORKDIR /app
COPY .npmrc ./
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.20.2-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    STATE_PATH=/data/state.json
WORKDIR /app
COPY .npmrc ./
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && mkdir -p /data \
    && chown node:node /app /data
COPY --from=build --chown=node:node /app/dist ./dist
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/watch.js"]
