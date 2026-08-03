# Server IP addresses

output "web_ipv4" {
  description = "Public IPv4 address of the web server"
  value       = hcloud_server.web.ipv4_address
}

output "web_ipv6" {
  description = "Public IPv6 address of the web server"
  value       = hcloud_server.web.ipv6_address
}

output "worker_ipv4" {
  description = "Public IPv4 address of the extraction worker"
  value       = hcloud_server.worker.ipv4_address
}

output "database_ipv4" {
  description = "Public IPv4 address of the database server (SSH access only)"
  value       = hcloud_server.database.ipv4_address
}

# Internal (private network) addresses

output "web_internal_ip" {
  description = "Internal IP of the web server"
  value       = "10.0.1.10"
}

output "worker_internal_ip" {
  description = "Internal IP of the extraction worker"
  value       = "10.0.1.20"
}

output "database_internal_ip" {
  description = "Internal IP of the database server"
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

# Estimated monthly cost

output "estimated_monthly_cost_eur" {
  description = "Approximate monthly cost in EUR (servers + volumes, excl. traffic)"
  value       = "~EUR 15/month (3 servers + 50GB database volume)"
}
