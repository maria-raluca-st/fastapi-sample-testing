#!/bin/bash

set -e

ENVIRONMENT="${1:-preview-$(whoami)}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="FastApiRunner-${ENVIRONMENT}"

echo "Deploying FastAPI sample to App Runner - Environment: $ENVIRONMENT"

# Check AWS CLI
if ! aws sts get-caller-identity --profile my-profile > /dev/null 2>&1; then
    echo "AWS CLI not configured. Run 'aws configure --profile my-profile' first."
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Docker is not running. Please start Docker first."
    exit 1
fi

# Install CDK if needed
if ! command -v cdk &> /dev/null; then
    echo "Installing AWS CDK..."
    npm install --no-progress -g aws-cdk
fi

# Install CDK dependencies
cd infra
npm install --no-progress
npm run build

# Bootstrap CDK
echo "Bootstrapping CDK..."
cdk bootstrap --profile my-profile --progress events

# Check if stack exists
STACK_EXISTS=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --profile my-profile 2>&1 || echo "NONE")

# First deployment: Create ECR repository only
if [[ "$STACK_EXISTS" == *"does not exist"* ]] || [[ "$STACK_EXISTS" == "NONE" ]]; then
    echo "First deployment detected - Creating ECR repository..."
    cdk deploy --context environment=$ENVIRONMENT --context createService=false --require-approval never --progress events --profile my-profile
fi

# Get ECR repository URI
REPOSITORY_URI=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`RepositoryUri`].OutputValue' \
  --output text \
  --region $REGION \
  --profile my-profile)

if [ "$REPOSITORY_URI" = "None" ] || [ -z "$REPOSITORY_URI" ]; then
    echo "Error: Could not retrieve ECR repository URI"
    exit 1
fi

echo "ECR Repository: $REPOSITORY_URI"

# Build and push Docker image
cd ../app
echo "Building Docker image..."
docker build --platform=linux/amd64 --quiet -t fastapi-sample:latest .

echo "Logging in to ECR..."
aws ecr get-login-password --region $REGION --profile my-profile | \
  docker login --username AWS --password-stdin $REPOSITORY_URI

echo "Tagging image..."
docker tag fastapi-sample:latest $REPOSITORY_URI:latest

echo "Pushing image to ECR..."
docker push --quiet $REPOSITORY_URI:latest

# Deploy full stack (including App Runner service)
cd ../infra
echo "Deploying CDK stack..."
cdk deploy --context environment=$ENVIRONMENT --require-approval never --progress events --profile my-profile

# Get service URL
SERVICE_URL=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceUrl`].OutputValue' \
  --output text \
  --region $REGION \
  --profile my-profile 2>&1 || echo "")

echo ""
echo "Deployment complete!"
if [ -n "$SERVICE_URL" ] && [ "$SERVICE_URL" != "None" ]; then
    echo "Service URL: $SERVICE_URL"
    echo ""
    echo "App Runner will automatically deploy the new image in ~2-5 minutes"
    echo ""
    echo "To test the service once deployed:"
    echo "  curl $SERVICE_URL/health"
else
    echo "Note: Service URL not available yet. Check AWS Console for status."
fi
echo ""
echo "Usage examples:"
echo "  ./scripts/deploy.sh                  # Deploy to preview-\$(whoami)"
echo "  ./scripts/deploy.sh dev              # Deploy to dev"
echo "  ./scripts/deploy.sh prod             # Deploy to production"
