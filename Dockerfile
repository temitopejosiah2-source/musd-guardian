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
    PORT=3000
WORKDIR /app
COPY .npmrc ./
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && chown node:node /app
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/watch.js"]
