# my-youtube infrastructure on DigitalOcean
#
# Usage:
#   export DIGITALOCEAN_TOKEN="your-api-token"
#   terraform init
#   terraform plan
#   terraform apply
#
# This creates:
#   - 1x web droplet (s-2vcpu-4gb: 2 vCPU, 4GB RAM)
#   - 1x extraction worker (s-4vcpu-8gb: 4 vCPU, 8GB RAM)
#   - 1x database droplet (s-2vcpu-4gb: 2 vCPU, 4GB RAM) running PostgreSQL + Redis
#   - 1x storage droplet (s-2vcpu-4gb: 2 vCPU, 4GB RAM) running MinIO
#   - VPC for private networking
#   - Firewalls restricting access
#   - Volumes for persistent data
#   - Reserved IP for web server

terraform {
  required_version = ">= 1.5"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.34"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

# --- SSH Key ---

resource "digitalocean_ssh_key" "deploy" {
  name       = "myyoutube-deploy"
  public_key = var.ssh_public_key
}

# --- VPC ---

resource "digitalocean_vpc" "internal" {
  name     = "myyoutube-internal"
  region   = var.region
  ip_range = "10.0.1.0/24"
}

# --- Firewalls ---

resource "digitalocean_firewall" "web" {
  name = "myyoutube-web"

  droplet_ids = [digitalocean_droplet.web.id]

  # SSH
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_ips
  }

  # HTTP
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # Allow all outbound
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_firewall" "worker" {
  name = "myyoutube-worker"

  droplet_ids = [digitalocean_droplet.worker.id]

  # SSH from admin
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_ips
  }

  # No inbound ports needed — workers connect outbound to Redis

  # Allow all outbound
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_firewall" "internal" {
  name = "myyoutube-internal"

  droplet_ids = [digitalocean_droplet.database.id, digitalocean_droplet.storage.id]

  # SSH from admin
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_ips
  }

  # PostgreSQL from VPC only
  inbound_rule {
    protocol         = "tcp"
    port_range       = "5432"
    source_addresses = ["10.0.1.0/24"]
  }

  # Redis from VPC only
  inbound_rule {
    protocol         = "tcp"
    port_range       = "6379"
    source_addresses = ["10.0.1.0/24"]
  }

  # MinIO API from VPC only
  inbound_rule {
    protocol         = "tcp"
    port_range       = "9000"
    source_addresses = ["10.0.1.0/24"]
  }

  # MinIO Console from admin only
  inbound_rule {
    protocol         = "tcp"
    port_range       = "9001"
    source_addresses = var.ssh_allowed_ips
  }

  # Allow all outbound
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# --- Droplets ---

resource "digitalocean_droplet" "web" {
  name     = "myyoutube-web"
  size     = var.web_droplet_size
  image    = "ubuntu-24-04-x64"
  region   = var.region
  vpc_uuid = digitalocean_vpc.internal.id
  ssh_keys = [digitalocean_ssh_key.deploy.fingerprint]

  tags = ["myyoutube", "web"]

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
}

resource "digitalocean_droplet" "worker" {
  name     = "myyoutube-worker"
  size     = var.worker_droplet_size
  image    = "ubuntu-24-04-x64"
  region   = var.region
  vpc_uuid = digitalocean_vpc.internal.id
  ssh_keys = [digitalocean_ssh_key.deploy.fingerprint]

  tags = ["myyoutube", "worker"]

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
}

resource "digitalocean_droplet" "database" {
  name     = "myyoutube-db"
  size     = var.db_droplet_size
  image    = "ubuntu-24-04-x64"
  region   = var.region
  vpc_uuid = digitalocean_vpc.internal.id
  ssh_keys = [digitalocean_ssh_key.deploy.fingerprint]

  tags = ["myyoutube", "database"]

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update
    apt-get install -y postgresql-16 redis-server

    # Get private IP from metadata
    PRIVATE_IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/private/0/ipv4/address)

    # PostgreSQL: listen on private network
    sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '$PRIVATE_IP,127.0.0.1'/" /etc/postgresql/16/main/postgresql.conf
    echo "host myyoutube myyoutube 10.0.1.0/24 scram-sha-256" >> /etc/postgresql/16/main/pg_hba.conf
    systemctl restart postgresql

    # Create database and user
    sudo -u postgres psql -c "CREATE USER myyoutube WITH PASSWORD '${var.postgres_password}';"
    sudo -u postgres psql -c "CREATE DATABASE myyoutube OWNER myyoutube;"

    # Redis: listen on private network with password
    sed -i "s/^bind .*/bind $PRIVATE_IP 127.0.0.1/" /etc/redis/redis.conf
    echo "requirepass ${var.redis_password}" >> /etc/redis/redis.conf
    echo "maxmemory 1gb" >> /etc/redis/redis.conf
    echo "maxmemory-policy allkeys-lru" >> /etc/redis/redis.conf
    systemctl restart redis-server

    echo "Database server provisioned."
  EOT
}

resource "digitalocean_droplet" "storage" {
  name     = "myyoutube-storage"
  size     = var.storage_droplet_size
  image    = "ubuntu-24-04-x64"
  region   = var.region
  vpc_uuid = digitalocean_vpc.internal.id
  ssh_keys = [digitalocean_ssh_key.deploy.fingerprint]

  tags = ["myyoutube", "storage"]

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
}

# --- Volumes (persistent storage) ---

resource "digitalocean_volume" "db_data" {
  region                  = var.region
  name                    = "myyoutube-db-data"
  size                    = var.db_volume_size
  initial_filesystem_type = "ext4"
}

resource "digitalocean_volume_attachment" "db_data" {
  droplet_id = digitalocean_droplet.database.id
  volume_id  = digitalocean_volume.db_data.id
}

resource "digitalocean_volume" "minio_data" {
  region                  = var.region
  name                    = "myyoutube-minio-data"
  size                    = var.storage_volume_size
  initial_filesystem_type = "ext4"
}

resource "digitalocean_volume_attachment" "minio_data" {
  droplet_id = digitalocean_droplet.storage.id
  volume_id  = digitalocean_volume.minio_data.id
}

# --- Reserved IP for Web Server ---

resource "digitalocean_reserved_ip" "web" {
  region = var.region
}

resource "digitalocean_reserved_ip_assignment" "web" {
  ip_address = digitalocean_reserved_ip.web.ip_address
  droplet_id = digitalocean_droplet.web.id
}

# --- Optional: Managed PostgreSQL (uncomment to use instead of self-hosted) ---
#
# resource "digitalocean_database_cluster" "postgres" {
#   name       = "myyoutube-db"
#   engine     = "pg"
#   version    = "16"
#   size       = "db-s-2vcpu-4gb"
#   region     = var.region
#   node_count = 1
#
#   private_network_uuid = digitalocean_vpc.internal.id
# }
#
# resource "digitalocean_database_db" "myyoutube" {
#   cluster_id = digitalocean_database_cluster.postgres.id
#   name       = "myyoutube"
# }
#
# resource "digitalocean_database_user" "myyoutube" {
#   cluster_id = digitalocean_database_cluster.postgres.id
#   name       = "myyoutube"
# }
#
# resource "digitalocean_database_firewall" "postgres" {
#   cluster_id = digitalocean_database_cluster.postgres.id
#
#   rule {
#     type  = "droplet"
#     value = digitalocean_droplet.web.id
#   }
#
#   rule {
#     type  = "droplet"
#     value = digitalocean_droplet.worker.id
#   }
# }

# --- Optional: Managed Redis via Marketplace (uncomment to use) ---
# Note: DigitalOcean offers managed Redis (database cluster with engine "redis")
#
# resource "digitalocean_database_cluster" "redis" {
#   name       = "myyoutube-redis"
#   engine     = "redis"
#   version    = "7"
#   size       = "db-s-1vcpu-2gb"
#   region     = var.region
#   node_count = 1
#
#   private_network_uuid = digitalocean_vpc.internal.id
# }
#
# resource "digitalocean_database_firewall" "redis" {
#   cluster_id = digitalocean_database_cluster.redis.id
#
#   rule {
#     type  = "droplet"
#     value = digitalocean_droplet.web.id
#   }
#
#   rule {
#     type  = "droplet"
#     value = digitalocean_droplet.worker.id
#   }
# }
