# C.A.R.E. Hub - Node + Supabase Postgres (via DATABASE_URL), no native modules.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

USER node
EXPOSE 3000
# Data lives in Supabase: pass DATABASE_URL (Transaction pooler string) at run time.
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
