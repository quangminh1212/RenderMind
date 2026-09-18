# --- Build stage ----------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Run the test suite in the builder, where dev dependencies still exist. The
# runtime image ships no test files, so running them there would silently find
# zero tests and report success.
COPY tests/ ./tests/
RUN npm test

# --- Production dependencies ----------------------------------
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Production stage -----------------------------------------
FROM node:20-alpine AS production

# Security: run as a non-root user.
RUN addgroup -g 1001 -S rendermind \
    && adduser -S rendermind -u 1001 -G rendermind

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=3000

# Liveness only. Readiness (/readyz) depends on provider configuration and must
# not gate the container's own health, or a Redis-less deployment gets restarted.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000

USER rendermind

CMD ["node", "dist/index.js"]
