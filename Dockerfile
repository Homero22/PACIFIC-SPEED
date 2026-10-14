# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (utilizes layer cache)
COPY package*.json ./
RUN npm ci

# Copy source and build both client (Vite MPA) and server (tsc)
COPY . .
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install production-only dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled artifacts and static assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
