FROM node:22-alpine

WORKDIR /app

# Ensure dependencies step and node_modules exist
COPY package*.json ./
RUN npm install --no-audit --no-fund || true

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "server.js"]
