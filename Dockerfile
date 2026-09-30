# Platform Trader: one Node process serves the static client and the WebSocket game server.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

# Install dependencies first so this layer stays cached until package*.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ server/
COPY shared/ shared/
COPY client/ client/

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Run node directly, not through npm, so SIGTERM reaches the server's shutdown handler.
CMD ["node", "server/main.js"]
