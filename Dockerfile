FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.11.0
COPY . .
ENV CI=true
RUN pnpm install --frozen-lockfile
RUN pnpm build:node

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NUXT_DATA_DIR=/data
COPY --from=build --chown=node:node /app/.output ./.output
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
