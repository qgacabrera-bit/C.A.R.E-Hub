# C.A.R.E. Hub - Node + built-in SQLite, no native modules.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    CARE_DB_PATH=/app/data/care-hub.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
# Mount a persistent volume here, or reports are lost on every redeploy.
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
