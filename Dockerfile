FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HERMES_WEB_UI_DATA_DIR=/app/.data
ENV PORT=3100
ENV HOSTNAME=0.0.0.0

RUN groupadd --system nodejs && useradd --system --gid nodejs --home-dir /app nextjs

# Build the standalone Next.js output on the host first with `npm run build`.
# This keeps packaging fast and avoids slow Docker-internal builds on small hosts.
COPY --chown=nextjs:nodejs public ./public
COPY --chown=nextjs:nodejs .next/standalone ./
COPY --chown=nextjs:nodejs .next/static ./.next/static

RUN mkdir -p /app/.data && chown -R nextjs:nodejs /app/.data
USER nextjs

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3100/api/runtime/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "server.js"]
