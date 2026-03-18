# DigitalOcean API token
variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

# SSH
variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "List of IP ranges allowed to SSH into servers (CIDR notation)"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  # Restrict this in production, e.g.: ["1.2.3.4/32"]
}

# Region
variable "region" {
  description = "DigitalOcean datacenter region"
  type        = string
  default     = "nyc3"
  # Options: nyc1, nyc3, sfo3, ams3, sgp1, lon1, fra1, blr1, tor1, syd1
}

# Domain
variable "domain" {
  description = "Domain name for the my-youtube instance"
  type        = string
  default     = "yourtube.example.com"
}

# Droplet sizes
# See https://slugs.do-api.dev/ for current slug list and pricing
variable "web_droplet_size" {
  description = "Droplet size slug for web server"
  type        = string
  default     = "s-2vcpu-4gb"
  # s-2vcpu-4gb: 2 vCPU, 4GB RAM, 80GB disk — $24/month
}

variable "worker_droplet_size" {
  description = "Droplet size slug for extraction workers"
  type        = string
  default     = "s-4vcpu-8gb"
  # s-4vcpu-8gb: 4 vCPU, 8GB RAM, 160GB disk — $48/month
}

variable "db_droplet_size" {
  description = "Droplet size slug for database (PostgreSQL + Redis)"
  type        = string
  default     = "s-2vcpu-4gb"
  # s-2vcpu-4gb: 2 vCPU, 4GB RAM — $24/month
}

variable "storage_droplet_size" {
  description = "Droplet size slug for MinIO storage"
  type        = string
  default     = "s-2vcpu-4gb"
  # s-2vcpu-4gb: 2 vCPU, 4GB RAM — $24/month
}

# Volume sizes (GB)
variable "db_volume_size" {
  description = "Size of the database volume in GB"
  type        = number
  default     = 50
}

variable "storage_volume_size" {
  description = "Size of the MinIO volume in GB"
  type        = number
  default     = 200
}

# Credentials
variable "postgres_password" {
  description = "PostgreSQL password for the myyoutube user"
  type        = string
  sensitive   = true
}

variable "redis_password" {
  description = "Redis requirepass password"
  type        = string
  sensitive   = true
}

variable "s3_access_key" {
  description = "MinIO root access key"
  type        = string
  sensitive   = true
  default     = "myyoutube-admin"
}

variable "s3_secret_key" {
  description = "MinIO root secret key"
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Express session secret (hex string, 32+ bytes)"
  type        = string
  sensitive   = true
}

variable "stream_secret" {
  description = "Stream token HMAC secret (hex string, 32+ bytes)"
  type        = string
  sensitive   = true
}
