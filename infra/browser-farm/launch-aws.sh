#!/usr/bin/env bash
# One-command ~$1/hr on-demand farm. Scale later: raise --count or ASG desired.
#   AWS_REGION=us-east-1 ./infra/browser-farm/launch-aws.sh
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
# 16 vCPU / 128 GB — Chrome is RAM-bound. ~$1.01/hr on-demand us-east-1.
TYPE="${INSTANCE_TYPE:-r6i.4xlarge}"
TOKEN="${BROWSERLESS_TOKEN:-mailgraph}"
CONCURRENT="${CONCURRENT:-100}"
SPOT="${SPOT:-0}"
COUNT="${COUNT:-1}"
NAME="${NAME:-mailgraph-browser-farm}"

command -v aws >/dev/null || { echo "aws cli required"; exit 1; }

AMI=$(aws ssm get-parameters \
  --region "$REGION" \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameters[0].Value' --output text)

SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values=mailgraph-browser-farm \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name mailgraph-browser-farm --description "Mailgraph Browserless 3000" \
    --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 3000 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
fi

USER_DATA=$(cat <<EOF
#!/bin/bash
dnf install -y docker
systemctl enable --now docker
echo 'vm.max_map_count=262144' >> /etc/sysctl.conf
sysctl -w vm.max_map_count=262144
docker run -d --restart unless-stopped --name browserless \
  --shm-size=4g -p 3000:3000 \
  -e CONCURRENT=${CONCURRENT} -e QUEUED=200 -e TIMEOUT=30000 \
  -e TOKEN=${TOKEN} \
  ghcr.io/browserless/chromium:latest
EOF
)

MARKET=()
if [[ "$SPOT" == "1" ]]; then
  MARKET=(--instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time","InstanceInterruptionBehavior":"terminate"}}')
fi

ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" --instance-type "$TYPE" --count "$COUNT" \
  --security-group-ids "$SG_ID" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  "${MARKET[@]}" \
  --query 'Instances[0].InstanceId' --output text)

echo "launched $ID ($TYPE x$COUNT). waiting for public IP..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$ID"
IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

echo
echo "BROWSERLESS_WS=ws://${IP}:3000/chromium/playwright?token=${TOKEN}"
echo "BROWSER_FARM_CONCURRENCY=${CONCURRENT}"
echo
echo "Finder: set those two env vars. ~2 min for docker pull."
echo "Scale: COUNT=3 $0   or   SPOT=1 $0"
echo "Stop:  aws ec2 terminate-instances --instance-ids $ID --region $REGION"
