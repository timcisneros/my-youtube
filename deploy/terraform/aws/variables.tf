# AWS Region
variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
  # Options: us-east-1, us-west-2, eu-west-1, eu-central-1, ap-southeast-1, etc.
}

variable "availability_zone" {
  description = "AWS availability zone within the region"
  type        = string
  default     = "us-east-1a"
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

# Domain
variable "domain" {
  description = "Domain name for the my-youtube instance"
  type        = string
  default     = "yourtube.example.com"
}

# Instance types
# See https://aws.amazon.com/ec2/pricing/on-demand/ for current pricing
variable "web_instance_type" {
  description = "EC2 instance type for web server"
  type        = string
  default     = "t3.medium"
  # t3.medium: 2 vCPU, 4GB RAM — ~$30/month
}

variable "worker_instance_type" {
  description = "EC2 instance type for extraction workers"
  type        = string
  default     = "t3.large"
  # t3.large: 2 vCPU, 8GB RAM — ~$60/month
}

variable "db_instance_type" {
  description = "EC2 instance type for database (PostgreSQL + Redis)"
  type        = string
  default     = "t3.medium"
  # t3.medium: 2 vCPU, 4GB RAM — ~$30/month
}

variable "storage_instance_type" {
  description = "EC2 instance type for MinIO storage"
  type        = string
  default     = "t3.medium"
  # t3.medium: 2 vCPU, 4GB RAM — ~$30/month
}

# Volume sizes (GB)
variable "db_volume_size" {
  description = "Size of the database EBS volume in GB"
  type        = number
  default     = 50
}

variable "storage_volume_size" {
  description = "Size of the MinIO EBS volume in GB"
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
