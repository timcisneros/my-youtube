# Hetzner Cloud API token
variable "hcloud_token" {
  description = "Hetzner Cloud API token"
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
variable "location" {
  description = "Hetzner datacenter location"
  type        = string
  default     = "fsn1"
  # Options: fsn1 (Falkenstein), nbg1 (Nuremberg), hel1 (Helsinki),
  #          ash (Ashburn), hil (Hillsboro), sin (Singapore)
}

# Domain
variable "domain" {
  description = "Domain name for the my-youtube instance"
  type        = string
  default     = "yourtube.example.com"
}

# Server types
# See https://www.hetzner.com/cloud for current pricing
variable "web_server_type" {
  description = "Hetzner server type for web server"
  type        = string
  default     = "cx22"
  # cx22: 2 vCPU, 4GB RAM, 40GB disk — ~EUR 5/month
}

variable "worker_server_type" {
  description = "Hetzner server type for extraction workers"
  type        = string
  default     = "cx32"
  # cx32: 4 vCPU, 8GB RAM, 80GB disk — ~EUR 10/month
}

variable "db_server_type" {
  description = "Hetzner server type for database (PostgreSQL + Redis)"
  type        = string
  default     = "cx22"
  # cx22: 2 vCPU, 4GB RAM — sufficient for 100K users
}

variable "storage_server_type" {
  description = "Hetzner server type for MinIO storage"
  type        = string
  default     = "cx22"
}

# Volume sizes (GB)
variable "db_volume_size" {
  description = "Size of the database persistent volume in GB"
  type        = number
  default     = 50
}

variable "storage_volume_size" {
  description = "Size of the MinIO persistent volume in GB"
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
