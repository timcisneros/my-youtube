# Server IP addresses

output "web_public_ip" {
  description = "Elastic IP of the web server"
  value       = aws_eip.web.public_ip
}

output "web_private_ip" {
  description = "Private IP of the web server"
  value       = aws_instance.web.private_ip
}

output "worker_private_ip" {
  description = "Private IP of the extraction worker"
  value       = aws_instance.worker.private_ip
}

output "database_private_ip" {
  description = "Private IP of the database server"
  value       = aws_instance.database.private_ip
}

# Connection strings for /etc/myyoutube/env

output "env_config" {
  description = "Environment variables for /etc/myyoutube/env"
  sensitive   = true
  value       = <<-EOT
    NODE_ENV=production
    PORT=3000
    DATABASE_URL=postgres://myyoutube:${var.postgres_password}@${aws_instance.database.private_ip}:5432/myyoutube
    REDIS_URL=redis://:${var.redis_password}@${aws_instance.database.private_ip}:6379
    SESSION_SECRET=${var.session_secret}
    STREAM_SECRET=${var.stream_secret}
    MAX_CONCURRENT_YTDLP=4
    MAX_EXTRACTION_WORKERS=2
  EOT
}

# SSH connection helpers

output "ssh_web" {
  description = "SSH command for web server"
  value       = "ssh ubuntu@${aws_eip.web.public_ip}"
}

output "ssh_worker" {
  description = "SSH command for worker (via web server as bastion)"
  value       = "ssh -J ubuntu@${aws_eip.web.public_ip} ubuntu@${aws_instance.worker.private_ip}"
}

output "ssh_database" {
  description = "SSH command for database (via web server as bastion)"
  value       = "ssh -J ubuntu@${aws_eip.web.public_ip} ubuntu@${aws_instance.database.private_ip}"
}

# Estimated monthly cost

output "estimated_monthly_cost_usd" {
  description = "Approximate monthly cost in USD (instances + volumes + NAT GW, excl. data transfer)"
  value       = "~$140/month (3 instances + 50GB EBS gp3 + NAT Gateway)"
}
