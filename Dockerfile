FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Jerusalem \
    PORT=3000 \
    DB_PATH=/app/data/chafcrm.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public

RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The data folder is a host volume; make sure the unprivileged "node" user can write it, then drop root.
CMD ["sh", "-c", "chown -R node:node /app/data && exec runuser -u node -- node src/server.js"]
