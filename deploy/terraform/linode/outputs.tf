# Server IP addresses

output "web_public_ip" {
  description = "Public IP of the web server"
  value       = linode_instance.web.ip_address
}

output "web_private_ip" {
  description = "VLAN IP of the web server"
  value       = "10.0.1.10"
}

output "worker_public_ip" {
  description = "Public IP of the extraction worker"
  value       = linode_instance.worker.ip_address
}

output "worker_private_ip" {
  description = "VLAN IP of the extraction worker"
  value       = "10.0.1.20"
}

output "database_public_ip" {
  description = "Public IP of the database server (SSH access only)"
  value       = linode_instance.database.ip_address
}

output "database_private_ip" {
  description = "VLAN IP of the database server"
  value       = "10.0.1.30"
}

output "storage_public_ip" {
  description = "Public IP of the storage server (SSH access only)"
  value       = linode_instance.storage.ip_address
}

output "storage_private_ip" {
  description = "VLAN IP of the storage server"
  value       = "10.0.1.40"
}

# Connection strings for /etc/myyoutube/env

output "env_config" {
  description = "Environment variables for /etc/myyoutube/env"
  sensitive   = true
  value       = <<-EOT
    NODE_ENV=production
    PORT=3000
    DATABASE_URL=postgres://myyoutube:${var.postgres_password}@10.0.1.30:5432/myyoutube
    REDIS_URL=redis://:${var.redis_password}@10.0.1.30:6379
    STORAGE_URL=s3://myyoutube
    S3_ENDPOINT=http://10.0.1.40:9000
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
  value       = "ssh root@${linode_instance.web.ip_address}"
}

output "ssh_worker" {
  description = "SSH command for worker"
  value       = "ssh root@${linode_instance.worker.ip_address}"
}

output "ssh_database" {
  description = "SSH command for database"
  value       = "ssh root@${linode_instance.database.ip_address}"
}

output "ssh_storage" {
  description = "SSH command for storage"
  value       = "ssh root@${linode_instance.storage.ip_address}"
}

# Estimated monthly cost

output "estimated_monthly_cost_usd" {
  description = "Approximate monthly cost in USD (instances + volumes, excl. bandwidth overages)"
  value       = "~$133/month (3x g6-standard-2 + 1x g6-standard-4 + 250GB volumes)"
}
