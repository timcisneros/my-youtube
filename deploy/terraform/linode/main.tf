# my-youtube infrastructure on Linode (Akamai)
#
# Usage:
#   export LINODE_TOKEN="your-api-token"
#   terraform init
#   terraform plan
#   terraform apply
#
# This creates:
#   - 1x web instance (g6-standard-2: 2 vCPU, 4GB RAM)
#   - 1x extraction worker (g6-standard-4: 4 vCPU, 8GB RAM)
#   - 1x database instance (g6-standard-2: 2 vCPU, 4GB RAM) running PostgreSQL + Redis
#   - 1x storage instance (g6-standard-2: 2 vCPU, 4GB RAM) running MinIO
#   - VLAN for private networking
#   - Firewall rules restricting access
#   - Volumes for persistent data

terraform {
  required_version = ">= 1.5"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.12"
    }
  }
}

provider "linode" {
  token = var.linode_token
}

# --- SSH Key ---

resource "linode_sshkey" "deploy" {
  label   = "myyoutube-deploy"
  ssh_key = var.ssh_public_key
}

# --- VLAN (private networking) ---
# Linode VLANs are defined inline on instance interfaces.
# All instances sharing the same VLAN label are on the same L2 network.
# We assign static IPs in the 10.0.1.0/24 range on the VLAN interface.

# --- Firewalls ---

resource "linode_firewall" "web" {
  label = "myyoutube-web"

  # SSH
  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = var.ssh_allowed_ips
  }

  # HTTP
  inbound {
    label    = "http"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "80"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  # HTTPS
  inbound {
    label    = "https"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "443"
    ipv4     = ["0.0.0.0/0"]
    ipv6     = ["::/0"]
  }

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [linode_instance.web.id]
}

resource "linode_firewall" "worker" {
  label = "myyoutube-worker"

  # SSH from admin
  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = var.ssh_allowed_ips
  }

  # No inbound ports needed — workers connect outbound to Redis

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [linode_instance.worker.id]
}

resource "linode_firewall" "internal" {
  label = "myyoutube-internal"

  # SSH from admin
  inbound {
    label    = "ssh"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "22"
    ipv4     = var.ssh_allowed_ips
  }

  # PostgreSQL — VLAN traffic bypasses Cloud Firewall, but we allow
  # from the public IPs of our instances as a fallback
  inbound {
    label    = "postgresql"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "5432"
    ipv4     = ["10.0.1.0/24"]
  }

  # Redis
  inbound {
    label    = "redis"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "6379"
    ipv4     = ["10.0.1.0/24"]
  }

  # MinIO API
  inbound {
    label    = "minio-api"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "9000"
    ipv4     = ["10.0.1.0/24"]
  }

  # MinIO Console from admin only
  inbound {
    label    = "minio-console"
    action   = "ACCEPT"
    protocol = "TCP"
    ports    = "9001"
    ipv4     = var.ssh_allowed_ips
  }

  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  linodes = [linode_instance.database.id, linode_instance.storage.id]
}

# --- Instances ---

resource "linode_instance" "web" {
  label           = "myyoutube-web"
  type            = var.web_instance_type
  image           = "linode/ubuntu24.04"
  region          = var.region
  authorized_keys = [var.ssh_public_key]
  tags            = ["myyoutube", "web"]

  interface {
    purpose = "public"
  }

  interface {
    purpose      = "vlan"
    label        = "myyoutube-vlan"
    ipam_address = "10.0.1.10/24"
  }

  metadata {
    user_data = base64encode(<<-EOT
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
    )
  }
}

resource "linode_instance" "worker" {
  label           = "myyoutube-worker"
  type            = var.worker_instance_type
  image           = "linode/ubuntu24.04"
  region          = var.region
  authorized_keys = [var.ssh_public_key]
  tags            = ["myyoutube", "worker"]

  interface {
    purpose = "public"
  }

  interface {
    purpose      = "vlan"
    label        = "myyoutube-vlan"
    ipam_address = "10.0.1.20/24"
  }

  metadata {
    user_data = base64encode(<<-EOT
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
    )
  }
}

resource "linode_instance" "database" {
  label           = "myyoutube-db"
  type            = var.db_instance_type
  image           = "linode/ubuntu24.04"
  region          = var.region
  authorized_keys = [var.ssh_public_key]
  tags            = ["myyoutube", "database"]

  interface {
    purpose = "public"
  }

  interface {
    purpose      = "vlan"
    label        = "myyoutube-vlan"
    ipam_address = "10.0.1.30/24"
  }

  metadata {
    user_data = base64encode(<<-EOT
      #!/bin/bash
      set -e
      apt-get update
      apt-get install -y postgresql-16 redis-server

      # PostgreSQL: listen on VLAN interface
      sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '10.0.1.30,127.0.0.1'/" /etc/postgresql/16/main/postgresql.conf
      echo "host myyoutube myyoutube 10.0.1.0/24 scram-sha-256" >> /etc/postgresql/16/main/pg_hba.conf
      systemctl restart postgresql

      # Create database and user
      sudo -u postgres psql -c "CREATE USER myyoutube WITH PASSWORD '${var.postgres_password}';"
      sudo -u postgres psql -c "CREATE DATABASE myyoutube OWNER myyoutube;"

      # Redis: listen on VLAN interface with password
      sed -i "s/^bind .*/bind 10.0.1.30 127.0.0.1/" /etc/redis/redis.conf
      echo "requirepass ${var.redis_password}" >> /etc/redis/redis.conf
      echo "maxmemory 1gb" >> /etc/redis/redis.conf
      echo "maxmemory-policy allkeys-lru" >> /etc/redis/redis.conf
      systemctl restart redis-server

      echo "Database server provisioned."
    EOT
    )
  }
}

resource "linode_instance" "storage" {
  label           = "myyoutube-storage"
  type            = var.storage_instance_type
  image           = "linode/ubuntu24.04"
  region          = var.region
  authorized_keys = [var.ssh_public_key]
  tags            = ["myyoutube", "storage"]

  interface {
    purpose = "public"
  }

  interface {
    purpose      = "vlan"
    label        = "myyoutube-vlan"
    ipam_address = "10.0.1.40/24"
  }

  metadata {
    user_data = base64encode(<<-EOT
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
    )
  }
}

# --- Volumes (persistent storage) ---
# Volumes are attached directly to instances via linode_id.
# The volume device path will be available at /dev/disk/by-id/scsi-0Linode_Volume_<label>

resource "linode_volume" "db_data" {
  label     = "myyoutube-db-data"
  region    = var.region
  size      = var.db_volume_size
  linode_id = linode_instance.database.id
}

resource "linode_volume" "minio_data" {
  label     = "myyoutube-minio-data"
  region    = var.region
  size      = var.storage_volume_size
  linode_id = linode_instance.storage.id
}
