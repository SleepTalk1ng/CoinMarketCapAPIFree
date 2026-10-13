FROM node:18.20.8-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY docs/openapi.json ./docs/openapi.json
COPY scripts/copy-migrations.cjs ./scripts/copy-migrations.cjs
RUN npm run build

FROM node:18.20.8-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --from=build /app/dist/ ./dist/
COPY local-view/ ./local-view/
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
