# my-youtube Deployment Guide

Production deployment guide for my-youtube — a privacy-focused YouTube frontend
that proxies all content through your own infrastructure with zero Google tracking
reaching your users.

**Architecture overview**: Express web app (cluster mode) + BullMQ extraction workers
+ Redis (cache/queue) + PostgreSQL or SQLite (metadata) + MinIO/S3 (segment storage)
+ nginx (reverse proxy/TLS).

---

## Table of Contents

1. [Single Machine (1-10K users)](#single-machine-1-10k-users)
2. [Docker Deployment (10K-100K users)](#docker-deployment-10k-100k-users)
3. [Multi-Region (100K-1M+ users)](#multi-region-100k-1m-users)
4. [Monitoring & Alerting](#monitoring--alerting)
5. [Security Hardening](#security-hardening)
6. [Maintenance](#maintenance)

---

## Single Machine (1-10K users)

Recommended specs: 4 vCPU, 8GB RAM, 100GB+ SSD (NVMe preferred).

### 1. Install Prerequisites

```bash
# Ubuntu 22.04 / 24.04
sudo apt update && sudo apt upgrade -y

# Node.js 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# ffmpeg (required for yt-dlp post-processing)
sudo apt install -y ffmpeg

# yt-dlp (latest release)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp

# nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Optional: Redis (for shared caches across cluster workers + BullMQ queue)
sudo apt install -y redis-server
sudo systemctl enable redis-server
```

Verify versions:

```bash
node --version    # v22.x
yt-dlp --version  # 2024.x or later
ffmpeg -version   # 6.x or later
nginx -v          # 1.18+
```

### 2. Create Application User

```bash
sudo useradd -r -m -s /bin/bash myyoutube
sudo mkdir -p /opt/myyoutube
sudo chown myyoutube:myyoutube /opt/myyoutube
```

### 3. Clone and Install

```bash
sudo -u myyoutube bash
cd /opt/myyoutube
git clone https://your-repo-url.git app
cd app
npm ci --production
```

### 4. Configure Environment

```bash
sudo mkdir -p /etc/myyoutube
sudo tee /etc/myyoutube/env << 'EOF'
NODE_ENV=production
PORT=3000

# Database: leave unset for SQLite, or set for PostgreSQL
# DATABASE_URL=postgres://myyoutube:secretpassword@localhost:5432/myyoutube

# Redis: enables shared caching + BullMQ extraction queue
REDIS_URL=redis://localhost:6379

# S3/MinIO storage (optional — falls back to local filesystem)
# STORAGE_URL=s3://myyoutube
# S3_ENDPOINT=http://localhost:9000
# S3_ACCESS_KEY=minioadmin
# S3_SECRET_KEY=minioadmin
# S3_REGION=us-east-1

# Session secret — generate with: openssl rand -hex 32
SESSION_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32

# Stream token secret — generate with: openssl rand -hex 32
STREAM_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32

# Extraction concurrency
MAX_CONCURRENT_YTDLP=4
MAX_EXTRACTION_WORKERS=2
EOF

sudo chmod 600 /etc/myyoutube/env
sudo chown myyoutube:myyoutube /etc/myyoutube/env
```

### 5. Install Systemd Services

```bash
# Copy from deploy/systemd/
sudo cp deploy/systemd/myyoutube.service /etc/systemd/system/
sudo cp deploy/systemd/myyoutube-worker.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable myyoutube myyoutube-worker
sudo systemctl start myyoutube myyoutube-worker
```

Check status:

```bash
sudo systemctl status myyoutube
sudo journalctl -u myyoutube -f
sudo journalctl -u myyoutube-worker -f
```

### 6. Configure nginx

```bash
# Copy nginx config (adjust server_name and paths)
sudo cp /opt/myyoutube/app/nginx.conf /etc/nginx/sites-available/myyoutube

# Edit: replace yourtube.example.com with your domain
# Edit: replace /path/to/my-youtube with /opt/myyoutube/app
sudo nano /etc/nginx/sites-available/myyoutube

# Add cache zones to the http block in /etc/nginx/nginx.conf:
# proxy_cache_path /var/cache/nginx/poster levels=1:2 keys_zone=poster_cache:10m max_size=1g inactive=24h;
# proxy_cache_path /var/cache/nginx/storyboard levels=1:2 keys_zone=storyboard_cache:10m max_size=2g inactive=24h;

sudo ln -s /etc/nginx/sites-available/myyoutube /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 7. Let's Encrypt TLS

```bash
sudo certbot --nginx -d yourtube.example.com
# certbot auto-renews via systemd timer; verify:
sudo systemctl list-timers | grep certbot
```

### 8. Backup Strategy

**SQLite (default database)**:

```bash
# SQLite hot backup via .backup command (safe with WAL mode)
sudo -u myyoutube sqlite3 /opt/myyoutube/app/data/tags.db ".backup /opt/myyoutube/backups/tags-$(date +%Y%m%d).db"
sudo -u myyoutube sqlite3 /opt/myyoutube/app/data/sessions.db ".backup /opt/myyoutube/backups/sessions-$(date +%Y%m%d).db"

# Cron: daily backup at 3am
echo '0 3 * * * myyoutube sqlite3 /opt/myyoutube/app/data/tags.db ".backup /opt/myyoutube/backups/tags-$(date +\%Y\%m\%d).db"' | sudo tee /etc/cron.d/myyoutube-backup
```

**PostgreSQL (when DATABASE_URL is set)**:

```bash
# pg_dump with compression
pg_dump -U myyoutube -h localhost myyoutube | gzip > /opt/myyoutube/backups/pg-$(date +%Y%m%d).sql.gz

# Cron: daily backup at 3am
echo '0 3 * * * myyoutube pg_dump -U myyoutube -h localhost myyoutube | gzip > /opt/myyoutube/backups/pg-$(date +\%Y\%m\%d).sql.gz' | sudo tee /etc/cron.d/myyoutube-backup
```

**Retention**: keep 7 daily, 4 weekly, 3 monthly backups. Use logrotate or a simple
script to prune old files.

**Local file storage** (when not using S3/MinIO):

```bash
# Rsync data directory to backup location
rsync -a /opt/myyoutube/app/data/downloads/ /opt/myyoutube/backups/downloads/
```

---

## Docker Deployment (10K-100K users)

Uses the provided `docker-compose.yml` which includes PostgreSQL, Redis, MinIO,
the web app, and extraction workers.

### 1. Prepare Host

```bash
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect
```

### 2. Configure

```bash
cd /opt/myyoutube/app

# Create .env file
cat > .env << 'EOF'
POSTGRES_PASSWORD=your-strong-pg-password-here
S3_ACCESS_KEY=your-minio-access-key
S3_SECRET_KEY=your-minio-secret-key
SESSION_SECRET=generate-with-openssl-rand-hex-32
STREAM_SECRET=generate-with-openssl-rand-hex-32
MAX_CONCURRENT_YTDLP=4
MAX_EXTRACTION_WORKERS=2
EXTRACTION_REPLICAS=2
EOF

chmod 600 .env
```

### 3. Start Full Stack

```bash
docker compose up -d

# Verify all services are healthy
docker compose ps
docker compose logs -f web
```

### 4. Scaling Extraction Workers

The extraction-worker service can be scaled independently:

```bash
# Scale to 4 extraction worker containers
docker compose up -d --scale extraction-worker=4

# Each worker runs MAX_EXTRACTION_WORKERS concurrent yt-dlp processes
# Total extraction concurrency = EXTRACTION_REPLICAS * MAX_EXTRACTION_WORKERS
# E.g., 4 containers * 2 workers each = 8 concurrent extractions
```

### 5. Put nginx in Front

On the Docker host, install nginx and proxy to port 3000:

```bash
# Use the same nginx.conf from the project root
# Set upstream to 127.0.0.1:3000
# Set up Let's Encrypt as in the single-machine section
```

### 6. Monitoring

```bash
# Real-time resource usage
docker stats

# Logs with timestamps
docker compose logs -f --timestamps

# Individual service logs
docker compose logs -f extraction-worker
docker compose logs -f postgres
```

### 7. Log Aggregation

For production, ship Docker logs to a central location:

```bash
# Option A: Docker logging driver to syslog
# In docker-compose.yml, add to each service:
#   logging:
#     driver: syslog
#     options:
#       syslog-address: "udp://logserver:514"
#       tag: "myyoutube-{{.Name}}"

# Option B: Loki + Promtail (lightweight, Grafana-native)
# Install Promtail on the Docker host, configure it to scrape
# /var/lib/docker/containers/*/*.log

# Option C: Vector.dev (Rust-based, low overhead)
# Single binary that tails Docker logs and ships to any destination
```

### 8. Backup Volumes

```bash
# Stop services for consistent backup (or use pg_dump for live backup)
docker compose stop

# Backup all named volumes
for vol in pg_data redis_data minio_data app_data; do
  docker run --rm -v "$(basename $(pwd))_${vol}:/data" -v /opt/myyoutube/backups:/backup \
    alpine tar czf "/backup/${vol}-$(date +%Y%m%d).tar.gz" -C /data .
done

docker compose start

# Or live PostgreSQL backup (no downtime):
docker compose exec postgres pg_dump -U myyoutube myyoutube | gzip > backup.sql.gz
```

### 9. Updates

```bash
# Pull latest code
git pull

# Rebuild and restart with zero downtime
docker compose build
docker compose up -d --remove-orphans

# Update yt-dlp inside running containers
docker compose exec web yt-dlp -U
docker compose exec extraction-worker yt-dlp -U
```

---

## Multi-Region (100K-1M+ users)

### Architecture

```
                        +------------------+
                        |  Geographic DNS  |
                        |  (Cloudflare)    |
                        +--------+---------+
                                 |
                 +---------------+---------------+
                 |                               |
         +-------+-------+             +--------+--------+
         |  Region: EU   |             |  Region: US     |
         +-------+-------+             +--------+--------+
                 |                               |
    +------------+------------+     +------------+------------+
    |            |            |     |            |            |
+---+---+  +----+----+  +----+--+  +---+---+  +----+----+  +----+--+
| Nginx |  | Varnish |  | nginx |  | Nginx |  | Varnish |  | nginx |
| LB    |  | Cache   |  | LB    |  | LB    |  | Cache   |  | LB    |
+---+---+  +----+----+  +---+---+  +---+---+  +----+----+  +---+---+
    |            |           |          |            |           |
    +------+-----+-----------+          +------+-----+-----------+
           |                                   |
    +------+------+                     +------+------+
    |  Web Cluster|                     |  Web Cluster|
    |  (2-4 nodes)|                     |  (2-4 nodes)|
    +------+------+                     +------+------+
           |                                   |
    +------+------+                     +------+------+
    |  Extraction |                     |  Extraction |
    |  Workers    |                     |  Workers    |
    |  (4-8 VPS)  |                     |  (4-8 VPS)  |
    +------+------+                     +------+------+
           |                                   |
    +------+------+                     +------+------+
    |  Redis      |                     |  Redis      |
    |  Sentinel   |                     |  Sentinel   |
    +------+------+                     +------+------+
           |                                   |
           +---------------+-------------------+
                           |
                  +--------+--------+
                  |  PostgreSQL     |
                  |  Primary + Read |
                  |  Replicas       |
                  +-----------------+
                           |
                  +--------+--------+
                  |  MinIO          |
                  |  Distributed    |
                  +-----------------+
```

### Geographic DNS Routing

Using Cloudflare (example):

1. Create two A/AAAA records for your domain, one per region
2. Enable Cloudflare Load Balancing with geo-steering
3. Create health checks for each region's nginx endpoint

```
# Cloudflare Load Balancer config (via dashboard or API)
Pool: eu-pool
  Origins: eu-web-1.example.com, eu-web-2.example.com
  Health check: GET /favicon.ico -> expect 204

Pool: us-pool
  Origins: us-web-1.example.com, us-web-2.example.com
  Health check: GET /favicon.ico -> expect 204

Steering: Geographic
  EU traffic -> eu-pool (fallback: us-pool)
  US traffic -> us-pool (fallback: eu-pool)
```

**Important privacy note**: If using Cloudflare proxy mode (orange cloud), TLS
terminates at Cloudflare and they can see request content. For maximum privacy,
use Cloudflare DNS-only mode (grey cloud) and terminate TLS on your own servers
with Let's Encrypt.

### PostgreSQL Primary + Read Replicas

**Option A: Managed PostgreSQL (recommended for simplicity)**

- [Neon](https://neon.tech) - serverless PG with branching, free tier
- [Supabase](https://supabase.com) - managed PG, good free tier
- Any managed PG that supports read replicas

Set `DATABASE_URL` to the primary for writes, optionally configure read replicas
for the web tier (requires app-level read/write splitting — not yet implemented).

**Option B: Self-hosted with Patroni (maximum control)**

```bash
# On 3 nodes (1 primary + 2 replicas):
sudo apt install -y postgresql-16 patroni python3-etcd

# /etc/patroni/patroni.yml on each node:
scope: myyoutube
name: pg-node-1  # unique per node

restapi:
  listen: 0.0.0.0:8008
  connect_address: THIS_NODE_IP:8008

etcd3:
  hosts: etcd1:2379,etcd2:2379,etcd3:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        max_connections: 200
        shared_buffers: 2GB
        wal_level: replica
        max_wal_senders: 5
        max_replication_slots: 5
  initdb:
    - encoding: UTF8
    - data-checksums

postgresql:
  listen: 0.0.0.0:5432
  connect_address: THIS_NODE_IP:5432
  data_dir: /var/lib/postgresql/16/main
  authentication:
    superuser:
      username: postgres
      password: CHANGE_ME
    replication:
      username: replicator
      password: CHANGE_ME
```

### Redis Cluster / Sentinel

For multi-region, use Redis Sentinel for automatic failover:

```bash
# On 3 nodes per region:
# /etc/redis/sentinel.conf
sentinel monitor myyoutube redis-primary-ip 6379 2
sentinel down-after-milliseconds myyoutube 5000
sentinel failover-timeout myyoutube 60000
sentinel parallel-syncs myyoutube 1
sentinel auth-pass myyoutube YOUR_REDIS_PASSWORD

# Start sentinel
redis-sentinel /etc/redis/sentinel.conf
```

Application connects via Sentinel-aware ioredis config:

```javascript
// In environment:
// REDIS_URL=redis+sentinel://sentinel1:26379,sentinel2:26379,sentinel3:26379/myyoutube/0
```

### Extraction Worker Fleet

Extraction workers are the most resource-intensive and IP-sensitive component.
Deploy them on separate VPS instances with different IP addresses to avoid
YouTube rate limiting.

**Per worker VPS**: 2 vCPU, 4GB RAM, 50GB SSD. Install Node.js, yt-dlp, ffmpeg.
Run `node extraction-worker.js` via systemd, pointed at the central Redis.

### IP Rotation Strategy

YouTube aggressively rate-limits extraction requests per IP. At scale, you need
IP diversity.

**Option A: Multiple VPS with Different IPs (simplest)**

Deploy extraction workers across multiple VPS providers/regions. Each VPS has a
unique public IP. The BullMQ queue naturally distributes work across all connected
workers.

```
VPS 1 (Hetzner DE)     -> extraction-worker (IP: 1.2.3.4)
VPS 2 (Hetzner FI)     -> extraction-worker (IP: 5.6.7.8)
VPS 3 (OVH FR)         -> extraction-worker (IP: 9.10.11.12)
VPS 4 (Contabo US)     -> extraction-worker (IP: 13.14.15.16)
```

All workers connect to the same Redis instance. BullMQ handles job distribution.
When one IP gets rate-limited, jobs naturally flow to other workers.

**Option B: IPv6 /48 Rotation with ndppd**

If your provider gives you a /48 or /64 IPv6 block, you can rotate through
millions of IPs:

```bash
# 1. Configure the IPv6 block
sudo ip -6 route add local 2001:db8:abcd::/48 dev lo

# 2. Install ndppd for neighbor discovery proxy
sudo apt install -y ndppd
cat > /etc/ndppd.conf << 'EOF'
route-ttl 30000
proxy eth0 {
  router yes
  timeout 500
  ttl 30000
  rule 2001:db8:abcd::/48 {
    static
  }
}
EOF
sudo systemctl enable --now ndppd

# 3. Configure yt-dlp to use random source IPs
# In extraction code or wrapper script:
# yt-dlp --source-address "2001:db8:abcd::$(openssl rand -hex 6 | sed 's/../&:/g;s/:$//')"
```

**Option C: SOCKS Proxy Rotation with Dante**

Run a SOCKS proxy on each extraction VPS, and route yt-dlp through them:

```bash
# On each proxy VPS, install Dante SOCKS server
sudo apt install -y dante-server

# /etc/danted.conf
logoutput: syslog
internal: eth0 port = 1080
external: eth0
socksmethod: none
client pass {
  from: YOUR_WORKER_IP/32 to: 0.0.0.0/0
}
socks pass {
  from: YOUR_WORKER_IP/32 to: 0.0.0.0/0
  protocol: tcp
}

# On extraction workers, rotate proxy per request:
# yt-dlp --proxy socks5://proxy1:1080 ...
# yt-dlp --proxy socks5://proxy2:1080 ...
```

### MinIO Distributed Mode

For durability and performance across nodes:

```bash
# On 4+ nodes with dedicated disks:
minio server http://minio{1...4}.example.com/data{1...4} \
  --console-address ":9001"

# Environment on each node:
export MINIO_ROOT_USER=your-access-key
export MINIO_ROOT_PASSWORD=your-secret-key
```

This provides erasure-coded storage across nodes with automatic healing.

### CDN Layer

**Option A: Varnish (self-hosted, see deploy/varnish.vcl)**

Place Varnish between nginx and the web app. Cache posters, thumbnails, and
storyboards. Pass through video segments (too large for Varnish).

```
Client -> nginx (TLS) -> Varnish (cache) -> Express app
```

```bash
sudo apt install -y varnish
sudo cp deploy/varnish.vcl /etc/varnish/default.vcl
# Adjust backend address and port
sudo systemctl enable --now varnish
```

**Option B: Cloudflare Cache Rules (managed CDN)**

If using Cloudflare DNS-only mode is not an option, configure page rules:

```
# Cache posters and thumbnails
URL: */api/stream/*/poster
Cache Level: Cache Everything, Edge TTL: 1 day

# Cache storyboards
URL: */api/stream/*/storyboard/*
Cache Level: Cache Everything, Edge TTL: 1 day

# Cache static assets
URL: */public/*
Cache Level: Cache Everything, Edge TTL: 7 days

# Bypass cache for everything else
URL: *
Cache Level: Bypass
```

**Important**: Cloudflare proxy mode (orange cloud) terminates TLS at their edge,
meaning Cloudflare can inspect traffic. If privacy is paramount, use DNS-only
mode and self-host your CDN with Varnish.

---

## Monitoring & Alerting

### Prometheus Metrics

Add a `/metrics` endpoint to the Express app (or use a sidecar exporter).
Key metrics to track:

```
# Request latency histogram
http_request_duration_seconds{method, route, status_code}

# Extraction queue depth
extraction_queue_waiting_total
extraction_queue_active_total

# Extraction success/failure rate
extraction_total{status="success|failure|timeout"}

# Cache hit rates
cache_hits_total{layer="l1|l2", namespace}
cache_misses_total{layer="l1|l2", namespace}

# Active WebSocket connections (SSE status)
ws_connections_active

# yt-dlp process count
ytdlp_processes_active
```

### Grafana Dashboard Suggestions

1. **Overview**: Request rate, error rate (4xx/5xx), p50/p95/p99 latency
2. **Extraction**: Queue depth, active workers, success rate, avg extraction time
3. **Cache**: L1/L2 hit rates, Redis memory usage, eviction rate
4. **Infrastructure**: CPU/RAM/disk per node, PostgreSQL connections, Redis ops/sec
5. **Bandwidth**: Bytes served (video segments), upstream bandwidth to YouTube

### Health Check Endpoints

The app exposes `GET /favicon.ico` (returns 204) as a lightweight health probe.
For deeper health checks, add:

```javascript
// Suggested addition to server.js
app.get('/health', async (req, res) => {
  const checks = {};
  // Database
  try { db.getDuration('test'); checks.db = 'ok'; }
  catch { checks.db = 'error'; }
  // Redis
  checks.redis = cache.hasRedis() ? 'ok' : 'unavailable';
  // yt-dlp
  try {
    require('child_process').execFileSync('yt-dlp', ['--version']);
    checks.ytdlp = 'ok';
  } catch { checks.ytdlp = 'error'; }

  const healthy = checks.db === 'ok' && checks.ytdlp === 'ok';
  res.status(healthy ? 200 : 503).json(checks);
});
```

### Alerting Rules

Configure in Prometheus Alertmanager or Grafana Alerting:

| Alert | Condition | Severity |
|---|---|---|
| Extraction failure rate high | `rate(extraction_total{status="failure"}[5m]) / rate(extraction_total[5m]) > 0.5` | Critical |
| Redis memory high | `redis_memory_used_bytes / redis_memory_max_bytes > 0.8` | Warning |
| PG connection pool exhaustion | `pg_stat_activity_count / pg_settings_max_connections > 0.9` | Critical |
| Web app down | `/health` returns non-200 for > 2 minutes | Critical |
| Extraction queue backlog | `extraction_queue_waiting_total > 50` for > 5 minutes | Warning |
| Disk space low | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1` | Critical |
| yt-dlp outdated | No successful extraction in > 1 hour during active usage | Warning |
| TLS certificate expiring | Certificate expires in < 14 days | Warning |

---

## Security Hardening

### Firewall Rules

```bash
# UFW (Ubuntu)
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (restrict to your IP if possible)
sudo ufw allow ssh

# HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Block everything else from outside
sudo ufw enable

# If using separate database/redis servers, allow only app server IPs:
# On PG server:   sudo ufw allow from APP_SERVER_IP to any port 5432
# On Redis server: sudo ufw allow from APP_SERVER_IP to any port 6379
```

### Fail2ban for SSH

```bash
sudo apt install -y fail2ban

cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
findtime = 600
EOF

sudo systemctl enable --now fail2ban
```

### Database Access Restrictions

**PostgreSQL**:

```bash
# /etc/postgresql/16/main/pg_hba.conf
# Only allow connections from app servers
host    myyoutube    myyoutube    APP_SERVER_IP/32    scram-sha-256
host    all          all          0.0.0.0/0           reject
```

**SQLite**: Already restricted by filesystem permissions. Ensure only the
`myyoutube` user can read/write `/opt/myyoutube/app/data/`.

### Redis Security

```bash
# /etc/redis/redis.conf
bind 127.0.0.1  # Or specific internal IP
requirepass YOUR_STRONG_REDIS_PASSWORD
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command DEBUG ""
rename-command CONFIG "CONFIG_a8f3b2d1"  # Obfuscate dangerous commands
```

Update `REDIS_URL` to include the password:

```
REDIS_URL=redis://:YOUR_STRONG_REDIS_PASSWORD@localhost:6379
```

### MinIO Bucket Policy

```bash
# Set bucket to private (no anonymous access)
mc anonymous set none local/myyoutube

# Create a dedicated app user with limited permissions
mc admin user add local myyoutube-app APP_SECRET_KEY
mc admin policy attach local readwrite --user myyoutube-app

# In production, create a custom policy that only allows access to the
# myyoutube bucket:
cat > /tmp/myyoutube-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::myyoutube",
      "arn:aws:s3:::myyoutube/*"
    ]
  }]
}
EOF
mc admin policy create local myyoutube-only /tmp/myyoutube-policy.json
mc admin policy attach local myyoutube-only --user myyoutube-app
```

### Regular yt-dlp Updates

yt-dlp must be updated frequently as YouTube changes their API. Set up a cron job:

```bash
# Update yt-dlp daily at 4am and restart workers to pick up changes
cat > /etc/cron.d/myyoutube-ytdlp-update << 'EOF'
0 4 * * * root /usr/local/bin/yt-dlp -U && systemctl restart myyoutube-worker 2>/dev/null; true
EOF
```

For Docker deployments:

```bash
# Add to crontab on the Docker host:
0 4 * * * docker compose -f /opt/myyoutube/app/docker-compose.yml exec -T web yt-dlp -U && docker compose -f /opt/myyoutube/app/docker-compose.yml exec -T extraction-worker yt-dlp -U && docker compose -f /opt/myyoutube/app/docker-compose.yml restart extraction-worker
```

### Additional Hardening

- **Disable root SSH**: `PermitRootLogin no` in `/etc/ssh/sshd_config`
- **Use SSH keys only**: `PasswordAuthentication no`
- **Keep OS updated**: `sudo unattended-upgrades` or regular `apt upgrade`
- **Restrict outbound**: If possible, limit outbound connections from the web
  server to only YouTube IPs (impractical due to CDN diversity, but consider
  for the database/Redis servers)
- **Audit logging**: Enable `auditd` for compliance-sensitive deployments

---

## Maintenance

### Rolling Restarts (Zero Downtime)

```bash
# Single machine: cluster.js handles worker rotation
sudo systemctl restart myyoutube

# Docker: rolling update
docker compose up -d --no-deps --build web
docker compose up -d --no-deps --build extraction-worker
```

### Database Migrations

The app auto-creates tables and runs migrations on startup (see `db.js`).
For PostgreSQL, `db-pg.js` handles the same. No manual migration steps needed.

### Disk Cleanup

```bash
# Remove old extraction cache (data/downloads for local storage)
find /opt/myyoutube/app/data/downloads -type f -mtime +7 -delete

# For MinIO, set a lifecycle policy:
mc ilm rule add local/myyoutube --expiry-days 30

# Clean old backups
find /opt/myyoutube/backups -name "*.gz" -mtime +30 -delete
find /opt/myyoutube/backups -name "*.db" -mtime +30 -delete
```
