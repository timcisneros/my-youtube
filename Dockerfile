# Build stage — install dependencies including native modules
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
# yt-dlp + ffmpeg for extraction
RUN apk add --no-cache python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

# Production stage
FROM node:22-alpine
RUN apk add --no-cache python3 ffmpeg tini
COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=builder /app/node_modules /app/node_modules
WORKDIR /app
COPY . .
# Don't run as root
RUN addgroup -S myyt && adduser -S myyt -G myyt && \
    mkdir -p /app/data && chown -R myyt:myyt /app/data
USER myyt
EXPOSE 3000
# Use tini as init for proper signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "cluster.js"]
