# Asset build stage — shared by the application and the lightweight edge image.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
ENV YOUTUBE_DL_SKIP_DOWNLOAD=1
RUN npm ci
COPY . .
RUN npm run build

# Application build stage — extraction tools and production-only dependencies
# are unnecessary when Compose builds only the edge target.
FROM builder AS app-builder
RUN apk add --no-cache python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp
RUN npm prune --omit=dev

# Edge stage — serve the exact runtime assets produced by the application build.
# Keeping this in the same multi-stage build prevents Nginx and Node from
# publishing different hashes during a rolling deployment.
FROM nginx:1.27-alpine AS edge
COPY deploy/nginx-compose.conf /etc/nginx/nginx.conf
COPY --from=builder /app/public /srv/my-youtube/public

# Production stage
FROM node:22-alpine AS app
RUN apk add --no-cache python3 ffmpeg tini
COPY --from=app-builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
WORKDIR /app
COPY --from=app-builder /app/package.json /app/package-lock.json ./
COPY --from=app-builder /app/node_modules ./node_modules
COPY --from=app-builder /app/dist ./dist
COPY --from=app-builder /app/public ./public
COPY --from=app-builder /app/views ./views
# Don't run as root
RUN addgroup -S myyt && adduser -S myyt -G myyt && \
    mkdir -p /app/data && chown -R myyt:myyt /app/data
USER myyt
EXPOSE 3000
# Use tini as init for proper signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/cluster.js"]
