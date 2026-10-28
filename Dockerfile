# syntax=docker/dockerfile:1
# Astro 7 (site/) needs Node >= 22.23
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies (utilizes layer cache): game/server at the root, content site in site/
COPY package*.json ./
COPY site/package*.json ./site/
RUN npm ci && npm --prefix site ci

# Copy source and build the content site (Astro), the game client (Vite) and the server (tsc)
COPY . .
# Article editor: production always stores articles in GitHub (never on the container disk)
ENV PUBLIC_KEYSTATIC_STORAGE=github
# Railway passes these service variables at build time
ARG PUBLIC_KEYSTATIC_GITHUB_APP_SLUG
ARG SITE_URL
ENV PUBLIC_KEYSTATIC_GITHUB_APP_SLUG=$PUBLIC_KEYSTATIC_GITHUB_APP_SLUG
ENV SITE_URL=$SITE_URL
RUN npm run build

# Production runtime stage
FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install production-only dependencies (the site's editor runs on demand at runtime)
COPY package*.json ./
COPY site/package*.json ./site/
RUN npm ci --omit=dev && npm --prefix site ci --omit=dev

# Copy compiled artifacts and static assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/site/dist ./site/dist

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
