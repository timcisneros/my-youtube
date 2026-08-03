# Server IP addresses

output "web_public_ip" {
  description = "Public IP of the web server"
  value       = tolist(linode_instance.web.ipv4)[0]
}

output "web_private_ip" {
  description = "VLAN IP of the web server"
  value       = "10.0.1.10"
}

output "worker_public_ip" {
  description = "Public IP of the extraction worker"
  value       = tolist(linode_instance.worker.ipv4)[0]
}

output "worker_private_ip" {
  description = "VLAN IP of the extraction worker"
  value       = "10.0.1.20"
}

output "database_public_ip" {
  description = "Public IP of the database server (SSH access only)"
  value       = tolist(linode_instance.database.ipv4)[0]
}

output "database_private_ip" {
  description = "VLAN IP of the database server"
  value       = "10.0.1.30"
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
    SESSION_SECRET=${var.session_secret}
    STREAM_SECRET=${var.stream_secret}
    MAX_CONCURRENT_YTDLP=4
    MAX_EXTRACTION_WORKERS=2
  EOT
}

# SSH connection helpers

output "ssh_web" {
  description = "SSH command for web server"
  value       = "ssh root@${tolist(linode_instance.web.ipv4)[0]}"
}

output "ssh_worker" {
  description = "SSH command for worker"
  value       = "ssh root@${tolist(linode_instance.worker.ipv4)[0]}"
}

output "ssh_database" {
  description = "SSH command for database"
  value       = "ssh root@${tolist(linode_instance.database.ipv4)[0]}"
}

# Estimated monthly cost

output "estimated_monthly_cost_usd" {
  description = "Approximate monthly cost in USD (instances + volumes, excl. bandwidth overages)"
  value       = "~$89/month (2x g6-standard-2 + 1x g6-standard-4 + 50GB volume)"
}
