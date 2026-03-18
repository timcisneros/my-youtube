# my-youtube Terraform Configurations

Infrastructure-as-code for deploying my-youtube across four cloud providers.
Each configuration creates the same architecture: 4 servers with private networking,
firewalls, and persistent storage.

## Architecture (all providers)

| Server   | Role                        | Private IP  |
|----------|-----------------------------|-------------|
| web      | Nginx + Node.js app server  | 10.0.1.10   |
| worker   | yt-dlp extraction worker    | 10.0.1.20   |
| database | PostgreSQL 16 + Redis       | 10.0.1.30   |
| storage  | MinIO (S3-compatible)       | 10.0.1.40   |

**Networking:** All servers communicate over a private network (VPC/VLAN).
PostgreSQL, Redis, and MinIO are only accessible from the private network.
Only the web server exposes HTTP/HTTPS publicly.

**Firewall rules:**
- Web: SSH (restricted), HTTP, HTTPS
- Worker: SSH (restricted), no inbound
- Database/Storage: SSH (restricted), PG/Redis/MinIO from private network only

## Monthly Cost Comparison

| Component        | Hetzner        | Linode         | DigitalOcean   | AWS              |
|------------------|----------------|----------------|----------------|------------------|
| Web (2c/4GB)     | EUR 5 (~$5)    | $24            | $24            | ~$30 (t3.medium) |
| Worker (4c/8GB)  | EUR 10 (~$11)  | $36            | $48            | ~$60 (t3.large)  |
| Database (2c/4GB)| EUR 5 (~$5)    | $24            | $24            | ~$30 (t3.medium) |
| Storage (2c/4GB) | EUR 5 (~$5)    | $24            | $24            | ~$30 (t3.medium) |
| DB Volume (50GB) | EUR 2          | $5             | $5             | ~$4 (gp3)        |
| MinIO Vol (200GB)| EUR 10         | $20            | $20            | ~$16 (gp3)       |
| Static/Elastic IP| Free           | Free           | Free (attached)| ~$4              |
| NAT Gateway      | N/A            | N/A            | N/A            | ~$32             |
| **Total**        | **~$30/mo**    | **~$133/mo**   | **~$145/mo**   | **~$185/mo**     |

> Prices are approximate and may vary by region. AWS is the most expensive due
> to NAT Gateway costs and higher instance pricing. Hetzner is the cheapest by
> a wide margin. Linode and DigitalOcean are in the middle.

### Which provider to choose?

- **Hetzner** -- Best value. Cheapest by far. EU-based (GDPR-friendly). Limited US regions.
- **Linode (Akamai)** -- Good balance of price and features. Wide region selection.
- **DigitalOcean** -- Developer-friendly UI. Managed database options. Slightly pricier.
- **AWS** -- Most features (RDS, ElastiCache, etc.). Best if you need AWS ecosystem. Most expensive.

## Quick Start

```bash
# 1. Choose your provider
cd deploy/terraform/aws  # or digitalocean, linode, hetzner

# 2. Create your config from the example
cp terraform.tfvars.example terraform.tfvars

# 3. Edit terraform.tfvars with your API token and credentials
#    IMPORTANT: Generate strong passwords!
#    openssl rand -hex 32  # for each password/secret

# 4. Initialize Terraform
terraform init

# 5. Preview what will be created
terraform plan

# 6. Create the infrastructure
terraform apply

# 7. Note the output values (IPs, connection strings)
terraform output
terraform output -raw env_config > /tmp/myyoutube.env
```

## What Gets Created

Each provider configuration creates:

1. **4 servers** (web, worker, database, storage) with Ubuntu 24.04
2. **Private network** (VPC or VLAN) for inter-server communication
3. **Firewalls** restricting access to internal services
4. **Persistent volumes** for database and MinIO data
5. **Static IP** for the web server
6. **cloud-init provisioning** that installs Node.js 22, yt-dlp, ffmpeg, PostgreSQL, Redis, and MinIO

## Post-Provisioning Steps

After `terraform apply` completes:

```bash
# 1. SSH into the web server
ssh root@<web_public_ip>  # or ubuntu@ for AWS

# 2. Write the environment config
terraform output -raw env_config | sudo tee /etc/myyoutube/env

# 3. Clone the application
sudo -u myyoutube git clone <repo_url> /opt/myyoutube/app

# 4. Install dependencies and build
cd /opt/myyoutube/app
sudo -u myyoutube npm ci
sudo -u myyoutube npm run build

# 5. Set up systemd service (or use the Ansible playbook)
# See deploy/ansible/ for automated deployment

# 6. Configure nginx and SSL
sudo certbot --nginx -d yourtube.example.com

# 7. Repeat for worker server (clone repo, install deps, start worker process)
```

Alternatively, use the Ansible playbook for automated deployment:
```bash
cd deploy/ansible
ansible-playbook -i inventory.ini site.yml
```

## Scaling

### Add more workers
Duplicate the worker resource in main.tf with a different name and private IP:
```hcl
resource "xxx_instance" "worker_2" {
  # Same config as worker, different name and IP (e.g., 10.0.1.21)
}
```

### Upgrade instance sizes
Change the instance type variables in terraform.tfvars:
```hcl
worker_instance_type = "t3.xlarge"  # AWS example: 4 vCPU, 16GB
```
Then run `terraform apply`. Note: this will restart the instance.

### Increase storage
Update the volume size variable and run `terraform apply`:
```hcl
storage_volume_size = 500  # GB
```
Then resize the filesystem on the server:
```bash
sudo resize2fs /dev/<volume_device>
```

### Use managed databases (AWS / DigitalOcean)
The AWS and DigitalOcean configs include commented-out resources for managed
PostgreSQL and Redis. Uncomment them and remove the self-hosted database instance
to switch to managed services. This increases cost but reduces operational burden.

## Tearing Down

```bash
# Preview what will be destroyed
terraform plan -destroy

# Destroy all resources
terraform destroy
```

**Before destroying:**
1. Back up your PostgreSQL database: `pg_dump myyoutube > backup.sql`
2. Back up MinIO data: `mc mirror myyoutube/myyoutube ./backup/`
3. Download any data from volumes before detaching

**Volumes with data:** Terraform will destroy EBS/Block Storage volumes.
If you need to preserve data, detach volumes manually first or use
`lifecycle { prevent_destroy = true }` on volume resources.

## File Structure

```
deploy/terraform/
├── README.md              # This file
├── main.tf                # Hetzner Cloud (default/original)
├── variables.tf           # Hetzner variables
├── outputs.tf             # Hetzner outputs
├── aws/
│   ├── main.tf            # AWS VPC + EC2 + EBS
│   ├── variables.tf
│   ├── outputs.tf
│   └── terraform.tfvars.example
├── digitalocean/
│   ├── main.tf            # DO VPC + Droplets + Volumes
│   ├── variables.tf
│   ├── outputs.tf
│   └── terraform.tfvars.example
└── linode/
    ├── main.tf            # Linode VLAN + Instances + Volumes
    ├── variables.tf
    ├── outputs.tf
    └── terraform.tfvars.example
```

## Security Notes

- Always restrict `ssh_allowed_ips` to your actual IP in production
- Never commit `terraform.tfvars` to version control (it contains secrets)
- Use `openssl rand -hex 32` to generate all passwords and secrets
- The `.tfvars.example` files are safe to commit (they contain placeholder values)
- Consider using Terraform state encryption or a remote backend for production
