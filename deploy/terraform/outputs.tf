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

output "storage_ipv4" {
  description = "Public IPv4 address of the storage server (SSH access only)"
  value       = hcloud_server.storage.ipv4_address
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

output "storage_internal_ip" {
  description = "Internal IP of the storage server"
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

# Estimated monthly cost

output "estimated_monthly_cost_eur" {
  description = "Approximate monthly cost in EUR (servers + volumes, excl. traffic)"
  value       = "~EUR 30/month (4x CX22/CX32 + 250GB volumes)"
}
