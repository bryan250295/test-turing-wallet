FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/prisma ./prisma
COPY shared /app/shared
COPY backend/tsconfig.json backend/prisma.config.ts ./
COPY backend/src ./src
COPY backend/scripts ./scripts
RUN npm run db:generate && npm run build
RUN chown node:node /app /app/backend
USER node

FROM base AS development
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM base AS production
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "start"]
