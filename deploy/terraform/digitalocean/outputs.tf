# Server IP addresses

output "web_public_ip" {
  description = "Reserved IP of the web server"
  value       = digitalocean_reserved_ip.web.ip_address
}

output "web_private_ip" {
  description = "Private IP of the web server"
  value       = digitalocean_droplet.web.ipv4_address_private
}

output "worker_public_ip" {
  description = "Public IPv4 of the extraction worker"
  value       = digitalocean_droplet.worker.ipv4_address
}

output "worker_private_ip" {
  description = "Private IP of the extraction worker"
  value       = digitalocean_droplet.worker.ipv4_address_private
}

output "database_private_ip" {
  description = "Private IP of the database server"
  value       = digitalocean_droplet.database.ipv4_address_private
}

output "storage_private_ip" {
  description = "Private IP of the storage server"
  value       = digitalocean_droplet.storage.ipv4_address_private
}

# Connection strings for /etc/myyoutube/env

output "env_config" {
  description = "Environment variables for /etc/myyoutube/env"
  sensitive   = true
  value       = <<-EOT
    NODE_ENV=production
    PORT=3000
    DATABASE_URL=postgres://myyoutube:${var.postgres_password}@${digitalocean_droplet.database.ipv4_address_private}:5432/myyoutube
    REDIS_URL=redis://:${var.redis_password}@${digitalocean_droplet.database.ipv4_address_private}:6379
    STORAGE_URL=s3://myyoutube
    S3_ENDPOINT=http://${digitalocean_droplet.storage.ipv4_address_private}:9000
    S3_ACCESS_KEY=${var.s3_access_key}
    S3_SECRET_KEY=${var.s3_secret_key}
    S3_REGION=us-east-1
    SESSION_SECRET=${var.session_secret}
    STREAM_SECRET=${var.stream_secret}
    MAX_CONCURRENT_YTDLP=4
    MAX_EXTRACTION_WORKERS=2
  EOT
}

# SSH connection helpers

output "ssh_web" {
  description = "SSH command for web server"
  value       = "ssh root@${digitalocean_reserved_ip.web.ip_address}"
}

output "ssh_worker" {
  description = "SSH command for worker"
  value       = "ssh root@${digitalocean_droplet.worker.ipv4_address}"
}

output "ssh_database" {
  description = "SSH command for database"
  value       = "ssh root@${digitalocean_droplet.database.ipv4_address}"
}

output "ssh_storage" {
  description = "SSH command for storage"
  value       = "ssh root@${digitalocean_droplet.storage.ipv4_address}"
}

# Estimated monthly cost

output "estimated_monthly_cost_usd" {
  description = "Approximate monthly cost in USD (droplets + volumes, excl. bandwidth overages)"
  value       = "~$145/month (3x s-2vcpu-4gb + 1x s-4vcpu-8gb + 250GB volumes)"
}
