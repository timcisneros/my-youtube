# my-youtube infrastructure on AWS
#
# Usage:
#   export AWS_ACCESS_KEY_ID="your-access-key"
#   export AWS_SECRET_ACCESS_KEY="your-secret-key"
#   terraform init
#   terraform plan
#   terraform apply
#
# This creates:
#   - 1x web server (t3.medium: 2 vCPU, 4GB RAM)
#   - 1x extraction worker (t3.large: 2 vCPU, 8GB RAM)
#   - 1x database server (t3.medium: 2 vCPU, 4GB RAM) running PostgreSQL + Redis
#   - 1x storage server (t3.medium: 2 vCPU, 4GB RAM) running MinIO
#   - VPC with private subnet
#   - Security groups restricting access
#   - EBS volumes for persistent data
#   - Elastic IP for web server

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# --- Data Sources ---

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --- SSH Key Pair ---

resource "aws_key_pair" "deploy" {
  key_name   = "myyoutube-deploy"
  public_key = var.ssh_public_key
}

# --- VPC ---

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "myyoutube-vpc"
    App  = "myyoutube"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "myyoutube-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name = "myyoutube-public"
  }
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = var.availability_zone

  tags = {
    Name = "myyoutube-private"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "myyoutube-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# NAT Gateway for private subnet outbound access
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "myyoutube-nat-eip"
  }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id

  tags = {
    Name = "myyoutube-nat-gw"
  }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = {
    Name = "myyoutube-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# --- Security Groups ---

resource "aws_security_group" "web" {
  name_prefix = "myyoutube-web-"
  description = "Web server security group"
  vpc_id      = aws_vpc.main.id

  # SSH
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_ips
  }

  # HTTP
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "myyoutube-web-sg"
  }
}

resource "aws_security_group" "worker" {
  name_prefix = "myyoutube-worker-"
  description = "Worker server security group"
  vpc_id      = aws_vpc.main.id

  # SSH
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_ips
  }

  # No inbound ports needed — workers connect outbound to Redis
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "myyoutube-worker-sg"
  }
}

resource "aws_security_group" "internal" {
  name_prefix = "myyoutube-internal-"
  description = "Internal services (DB, Redis, MinIO) security group"
  vpc_id      = aws_vpc.main.id

  # SSH from admin
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_ips
  }

  # PostgreSQL from VPC
  ingress {
    description = "PostgreSQL"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  # Redis from VPC
  ingress {
    description = "Redis"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  # MinIO API from VPC
  ingress {
    description = "MinIO API"
    from_port   = 9000
    to_port     = 9000
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  # MinIO Console from admin only
  ingress {
    description = "MinIO Console"
    from_port   = 9001
    to_port     = 9001
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_ips
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "myyoutube-internal-sg"
  }
}

# --- EC2 Instances ---

resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.web_instance_type
  key_name               = aws_key_pair.deploy.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  private_ip             = "10.0.1.10"

  root_block_device {
    volume_size = 40
    volume_type = "gp3"
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

  tags = {
    Name = "myyoutube-web"
    App  = "myyoutube"
    Role = "web"
  }
}

resource "aws_instance" "worker" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.worker_instance_type
  key_name               = aws_key_pair.deploy.key_name
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.worker.id]
  private_ip             = "10.0.2.20"

  root_block_device {
    volume_size = 80
    volume_type = "gp3"
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

  tags = {
    Name = "myyoutube-worker"
    App  = "myyoutube"
    Role = "worker"
  }
}

resource "aws_instance" "database" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.db_instance_type
  key_name               = aws_key_pair.deploy.key_name
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.internal.id]
  private_ip             = "10.0.2.30"

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = <<-EOT
    #!/bin/bash
    set -e
    apt-get update
    apt-get install -y postgresql-16 redis-server

    # PostgreSQL: listen on private network
    sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '10.0.2.30,127.0.0.1'/" /etc/postgresql/16/main/postgresql.conf
    echo "host myyoutube myyoutube 10.0.0.0/16 scram-sha-256" >> /etc/postgresql/16/main/pg_hba.conf
    systemctl restart postgresql

    # Create database and user
    sudo -u postgres psql -c "CREATE USER myyoutube WITH PASSWORD '${var.postgres_password}';"
    sudo -u postgres psql -c "CREATE DATABASE myyoutube OWNER myyoutube;"

    # Redis: listen on private network with password
    sed -i "s/^bind .*/bind 10.0.2.30 127.0.0.1/" /etc/redis/redis.conf
    echo "requirepass ${var.redis_password}" >> /etc/redis/redis.conf
    echo "maxmemory 1gb" >> /etc/redis/redis.conf
    echo "maxmemory-policy allkeys-lru" >> /etc/redis/redis.conf
    systemctl restart redis-server

    echo "Database server provisioned."
  EOT

  tags = {
    Name = "myyoutube-db"
    App  = "myyoutube"
    Role = "database"
  }
}

resource "aws_instance" "storage" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.storage_instance_type
  key_name               = aws_key_pair.deploy.key_name
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.internal.id]
  private_ip             = "10.0.2.40"

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
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

  tags = {
    Name = "myyoutube-storage"
    App  = "myyoutube"
    Role = "storage"
  }
}

# --- EBS Volumes (persistent storage) ---

resource "aws_ebs_volume" "db_data" {
  availability_zone = var.availability_zone
  size              = var.db_volume_size
  type              = "gp3"

  tags = {
    Name = "myyoutube-db-data"
    App  = "myyoutube"
  }
}

resource "aws_volume_attachment" "db_data" {
  device_name = "/dev/xvdf"
  volume_id   = aws_ebs_volume.db_data.id
  instance_id = aws_instance.database.id
}

resource "aws_ebs_volume" "minio_data" {
  availability_zone = var.availability_zone
  size              = var.storage_volume_size
  type              = "gp3"

  tags = {
    Name = "myyoutube-minio-data"
    App  = "myyoutube"
  }
}

resource "aws_volume_attachment" "minio_data" {
  device_name = "/dev/xvdg"
  volume_id   = aws_ebs_volume.minio_data.id
  instance_id = aws_instance.storage.id
}

# --- Elastic IP for Web Server ---

resource "aws_eip" "web" {
  instance = aws_instance.web.id
  domain   = "vpc"

  tags = {
    Name = "myyoutube-web-eip"
  }
}

# --- Optional: RDS PostgreSQL (uncomment to use managed database instead) ---
#
# resource "aws_db_subnet_group" "main" {
#   name       = "myyoutube-db-subnet"
#   subnet_ids = [aws_subnet.private.id]
#   # Note: RDS requires at least 2 subnets in different AZs.
#   # Add a second private subnet in another AZ for production use.
#
#   tags = {
#     Name = "myyoutube-db-subnet-group"
#   }
# }
#
# resource "aws_db_instance" "postgres" {
#   identifier           = "myyoutube-db"
#   engine               = "postgres"
#   engine_version       = "16"
#   instance_class       = "db.t3.medium"
#   allocated_storage    = var.db_volume_size
#   storage_type         = "gp3"
#   db_name              = "myyoutube"
#   username             = "myyoutube"
#   password             = var.postgres_password
#   db_subnet_group_name = aws_db_subnet_group.main.name
#   vpc_security_group_ids = [aws_security_group.internal.id]
#   skip_final_snapshot  = false
#   final_snapshot_identifier = "myyoutube-db-final"
#   backup_retention_period   = 7
#   multi_az             = false  # Set true for HA (~2x cost)
#
#   tags = {
#     Name = "myyoutube-rds"
#     App  = "myyoutube"
#   }
# }

# --- Optional: ElastiCache Redis (uncomment to use managed Redis) ---
#
# resource "aws_elasticache_subnet_group" "main" {
#   name       = "myyoutube-redis-subnet"
#   subnet_ids = [aws_subnet.private.id]
# }
#
# resource "aws_elasticache_replication_group" "redis" {
#   replication_group_id = "myyoutube-redis"
#   description          = "my-youtube Redis cluster"
#   node_type            = "cache.t3.medium"
#   num_cache_clusters   = 1
#   port                 = 6379
#   subnet_group_name    = aws_elasticache_subnet_group.main.name
#   security_group_ids   = [aws_security_group.internal.id]
#   at_rest_encryption_enabled = true
#   transit_encryption_enabled = true
#   auth_token           = var.redis_password
#
#   tags = {
#     Name = "myyoutube-redis"
#     App  = "myyoutube"
#   }
# }
