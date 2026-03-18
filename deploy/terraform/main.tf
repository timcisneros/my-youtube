# my-youtube infrastructure on Hetzner Cloud
#
# Usage:
#   export HCLOUD_TOKEN="your-api-token"
#   terraform init
#   terraform plan
#   terraform apply
#
# This creates:
#   - 1x web server (CX22: 2 vCPU, 4GB RAM)
#   - 1x extraction worker (CX32: 4 vCPU, 8GB RAM)
#   - 1x database server (CX22: 2 vCPU, 4GB RAM) running PostgreSQL + Redis
#   - 1x storage server (CX22: 2 vCPU, 4GB RAM) running MinIO
#   - Firewall rules restricting access
#   - Private network for inter-server communication
#   - DNS records (optional)

terraform {
  required_version = ">= 1.5"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# --- SSH Key ---

resource "hcloud_ssh_key" "deploy" {
  name       = "myyoutube-deploy"
  public_key = var.ssh_public_key
}

# --- Private Network ---

resource "hcloud_network" "internal" {
  name     = "myyoutube-internal"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "servers" {
  network_id   = hcloud_network.internal.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}

# --- Firewalls ---

resource "hcloud_firewall" "web" {
  name = "myyoutube-web"

  # SSH
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = var.ssh_allowed_ips
  }

  # HTTP
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_firewall" "internal" {
  name = "myyoutube-internal"

  # SSH from admin
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = var.ssh_allowed_ips
  }

  # PostgreSQL from internal network only
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "5432"
    source_ips = ["10.0.1.0/24"]
  }

  # Redis from internal network only
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "6379"
    source_ips = ["10.0.1.0/24"]
  }

  # MinIO API from internal network only
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "9000"
    source_ips = ["10.0.1.0/24"]
  }

  # MinIO Console from admin only
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "9001"
    source_ips = var.ssh_allowed_ips
  }
}

resource "hcloud_firewall" "worker" {
  name = "myyoutube-worker"

  # SSH from admin
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = var.ssh_allowed_ips
  }

  # No inbound ports needed — workers connect outbound to Redis
}

# --- Servers ---

resource "hcloud_server" "web" {
  name        = "myyoutube-web"
  server_type = var.web_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.web.id]

  labels = {
    app  = "myyoutube"
    role = "web"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update
    apt-get install -y curl
    # Node.js 22
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs nginx certbot python3-certbot-nginx ffmpeg
    # yt-dlp
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
    chmod +x /usr/local/bin/yt-dlp
    # App user
    useradd -r -m -s /bin/bash myyoutube
    mkdir -p /opt/myyoutube /etc/myyoutube
    chown myyoutube:myyoutube /opt/myyoutube
    echo "Web server provisioned. Clone repo to /opt/myyoutube/app and configure /etc/myyoutube/env"
  EOT

  network {
    network_id = hcloud_network.internal.id
    ip         = "10.0.1.10"
  }

  depends_on = [hcloud_network_subnet.servers]
}

resource "hcloud_server" "worker" {
  name        = "myyoutube-worker"
  server_type = var.worker_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.worker.id]

  labels = {
    app  = "myyoutube"
    role = "worker"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update
    apt-get install -y curl
    # Node.js 22
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs ffmpeg
    # yt-dlp
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
    chmod +x /usr/local/bin/yt-dlp
    # App user
    useradd -r -m -s /bin/bash myyoutube
    mkdir -p /opt/myyoutube /etc/myyoutube
    chown myyoutube:myyoutube /opt/myyoutube
    echo "Worker provisioned. Clone repo to /opt/myyoutube/app and configure /etc/myyoutube/env"
  EOT

  network {
    network_id = hcloud_network.internal.id
    ip         = "10.0.1.20"
  }

  depends_on = [hcloud_network_subnet.servers]
}

resource "hcloud_server" "database" {
  name        = "myyoutube-db"
  server_type = var.db_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.internal.id]

  labels = {
    app  = "myyoutube"
    role = "database"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update
    apt-get install -y postgresql-16 redis-server

    # PostgreSQL: listen on private network
    sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '10.0.1.30,127.0.0.1'/" /etc/postgresql/16/main/postgresql.conf
    echo "host myyoutube myyoutube 10.0.1.0/24 scram-sha-256" >> /etc/postgresql/16/main/pg_hba.conf
    systemctl restart postgresql

    # Create database and user
    sudo -u postgres psql -c "CREATE USER myyoutube WITH PASSWORD '${var.postgres_password}';"
    sudo -u postgres psql -c "CREATE DATABASE myyoutube OWNER myyoutube;"

    # Redis: listen on private network with password
    sed -i "s/^bind .*/bind 10.0.1.30 127.0.0.1/" /etc/redis/redis.conf
    echo "requirepass ${var.redis_password}" >> /etc/redis/redis.conf
    echo "maxmemory 1gb" >> /etc/redis/redis.conf
    echo "maxmemory-policy allkeys-lru" >> /etc/redis/redis.conf
    systemctl restart redis-server

    echo "Database server provisioned."
  EOT

  network {
    network_id = hcloud_network.internal.id
    ip         = "10.0.1.30"
  }

  depends_on = [hcloud_network_subnet.servers]
}

resource "hcloud_server" "storage" {
  name        = "myyoutube-storage"
  server_type = var.storage_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.internal.id]

  labels = {
    app  = "myyoutube"
    role = "storage"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update

    # Install MinIO
    curl -L https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio
    chmod +x /usr/local/bin/minio

    # Install MinIO client
    curl -L https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
    chmod +x /usr/local/bin/mc

    # Create minio user and data directory
    useradd -r -m -s /bin/false minio
    mkdir -p /data/minio
    chown minio:minio /data/minio

    # Systemd service for MinIO
    cat > /etc/systemd/system/minio.service << 'UNIT'
    [Unit]
    Description=MinIO Object Storage
    After=network.target

    [Service]
    Type=simple
    User=minio
    Group=minio
    ExecStart=/usr/local/bin/minio server /data/minio --address ":9000" --console-address ":9001"
    Environment=MINIO_ROOT_USER=${var.s3_access_key}
    Environment=MINIO_ROOT_PASSWORD=${var.s3_secret_key}
    Restart=always
    RestartSec=5
    LimitNOFILE=65535

    [Install]
    WantedBy=multi-user.target
    UNIT

    systemctl daemon-reload
    systemctl enable --now minio

    # Wait for MinIO to start, then create bucket
    sleep 5
    mc alias set local http://localhost:9000 ${var.s3_access_key} ${var.s3_secret_key}
    mc mb --ignore-existing local/myyoutube

    echo "Storage server provisioned."
  EOT

  network {
    network_id = hcloud_network.internal.id
    ip         = "10.0.1.40"
  }

  depends_on = [hcloud_network_subnet.servers]
}

# --- Volumes (persistent storage) ---

resource "hcloud_volume" "db_data" {
  name      = "myyoutube-db-data"
  size      = var.db_volume_size
  location  = var.location
  format    = "ext4"
  automount = true
}

resource "hcloud_volume_attachment" "db_data" {
  volume_id = hcloud_volume.db_data.id
  server_id = hcloud_server.database.id
  automount = true
}

resource "hcloud_volume" "minio_data" {
  name      = "myyoutube-minio-data"
  size      = var.storage_volume_size
  location  = var.location
  format    = "ext4"
  automount = true
}

resource "hcloud_volume_attachment" "minio_data" {
  volume_id = hcloud_volume.minio_data.id
  server_id = hcloud_server.storage.id
  automount = true
}

# --- DNS Records (optional, requires Hetzner DNS zone) ---

resource "hcloud_rdns" "web_ipv4" {
  server_id  = hcloud_server.web.id
  ip_address = hcloud_server.web.ipv4_address
  dns_ptr    = var.domain
}
