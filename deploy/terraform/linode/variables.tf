# Linode API token
variable "linode_token" {
  description = "Linode (Akamai) API token"
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
  default     = ["0.0.0.0/0"]
  # Restrict this in production, e.g.: ["1.2.3.4/32"]
}

# Region
variable "region" {
  description = "Linode datacenter region"
  type        = string
  default     = "us-east"
  # Options: us-east (Newark), us-central (Dallas), us-west (Fremont),
  #          eu-west (London), eu-central (Frankfurt), ap-south (Singapore),
  #          ap-southeast (Sydney), ap-northeast (Tokyo)
}

# Domain
variable "domain" {
  description = "Domain name for the my-youtube instance"
  type        = string
  default     = "yourtube.example.com"
}

# Instance types
# See https://www.linode.com/pricing/ for current pricing
variable "web_instance_type" {
  description = "Linode plan for web server"
  type        = string
  default     = "g6-standard-2"
  # g6-standard-2: 2 vCPU, 4GB RAM, 80GB disk — $24/month
}

variable "worker_instance_type" {
  description = "Linode plan for extraction workers"
  type        = string
  default     = "g6-standard-4"
  # g6-standard-4: 4 vCPU, 8GB RAM, 160GB disk — $36/month
}

variable "db_instance_type" {
  description = "Linode plan for database (PostgreSQL + Redis)"
  type        = string
  default     = "g6-standard-2"
  # g6-standard-2: 2 vCPU, 4GB RAM — $24/month
}

variable "storage_instance_type" {
  description = "Linode plan for MinIO storage"
  type        = string
  default     = "g6-standard-2"
  # g6-standard-2: 2 vCPU, 4GB RAM — $24/month
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
