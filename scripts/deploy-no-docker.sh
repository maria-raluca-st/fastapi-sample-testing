#!/bin/bash

set -e

ENVIRONMENT="${1:-preview-$(whoami)}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="FastApiRunner-${ENVIRONMENT}"
BUILD_STACK_NAME="FastApiBuild-${ENVIRONMENT}"

echo "Deploying FastAPI sample to App Runner (without local Docker) - Environment: $ENVIRONMENT"

# Check AWS CLI
if ! aws sts get-caller-identity --profile my-profile > /dev/null 2>&1; then
    echo "AWS CLI not configured. Run 'aws configure --profile my-profile' first."
    exit 1
fi

export AWS_PROFILE=my-profile
export AWS_REGION=$REGION

# Install CDK if needed
if ! command -v cdk &> /dev/null; then
    echo "Installing AWS CDK..."
    npm install --no-progress -g aws-cdk
fi

# Install CDK dependencies
cd infra
npm install --no-progress
npm run build

# Bootstrap CDK if needed
echo "Checking CDK bootstrap..."
cdk bootstrap --profile my-profile --progress events || true

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

# Create a zip file of the app directory for CodeBuild
cd ..
echo "Preparing source code for CodeBuild..."
TEMP_DIR=$(mktemp -d)
cp -r app "$TEMP_DIR/"
cp -r infra "$TEMP_DIR/" 2>/dev/null || true
cd "$TEMP_DIR"

# Create buildspec.yml for CodeBuild
cat > buildspec.yml <<EOF
version: 0.2
phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REPOSITORY_URI
      - COMMIT_HASH=\$(echo \$CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)
      - IMAGE_TAG=\${COMMIT_HASH:-latest}
  build:
    commands:
      - echo Build started on \`date\`
      - echo Building the Docker image...
      - docker build --platform=linux/amd64 -t fastapi-sample:\$IMAGE_TAG -f app/Dockerfile app
      - docker tag fastapi-sample:\$IMAGE_TAG $REPOSITORY_URI:latest
  post_build:
    commands:
      - echo Build completed on \`date\`
      - echo Pushing the Docker images...
      - docker push $REPOSITORY_URI:latest
      - echo Writing image definitions file...
      - printf '{"ImageURI":"%s"}' $REPOSITORY_URI:latest > imageDetail.json
artifacts:
  files:
    - imageDetail.json
EOF

# Create zip file
zip -r source.zip . -x "*.git*" "node_modules/*" "cdk.out/*" "dist/*" > /dev/null 2>&1

# Use AWS CodeBuild to build and push the image
echo "Starting CodeBuild to build and push Docker image..."

# Create CodeBuild project if it doesn't exist
PROJECT_NAME="fastapi-build-${ENVIRONMENT}"
PROJECT_EXISTS=$(aws codebuild list-projects --profile my-profile --region $REGION --query "projects[?@=='$PROJECT_NAME']" --output text 2>/dev/null || echo "")

if [ -z "$PROJECT_EXISTS" ]; then
    echo "Creating CodeBuild project..."
    
    # Get ECR repository name
    REPO_NAME=$(echo $REPOSITORY_URI | cut -d'/' -f2)
    
    # Create IAM role for CodeBuild
    cat > /tmp/codebuild-role-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
    
    ROLE_NAME="codebuild-${PROJECT_NAME}-role"
    ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --profile my-profile --query 'Role.Arn' --output text 2>/dev/null || echo "")
    
    if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
        echo "Creating IAM role for CodeBuild..."
        aws iam create-role --role-name $ROLE_NAME --assume-role-policy-document file:///tmp/codebuild-role-policy.json --profile my-profile > /dev/null 2>&1 || true
        aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess --profile my-profile
        aws iam attach-role-policy --role-name $ROLE_NAME --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser --profile my-profile
        sleep 5  # Wait for role to propagate
        ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --profile my-profile --query 'Role.Arn' --output text)
    fi
    
    # Create CodeBuild project
    cat > /tmp/codebuild-project.json <<EOF
{
  "name": "$PROJECT_NAME",
  "description": "Build FastAPI Docker image",
  "source": {
    "type": "S3",
    "location": "will-be-updated"
  },
  "artifacts": {
    "type": "NO_ARTIFACTS"
  },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/standard:7.0",
    "computeType": "BUILD_GENERAL1_SMALL",
    "privilegedMode": true
  },
  "serviceRole": "$ROLE_ARN"
}
EOF
    
    # Upload source to S3
    BUCKET_NAME="codebuild-source-${ENVIRONMENT}-$(date +%s)"
    aws s3 mb s3://$BUCKET_NAME --region $REGION --profile my-profile 2>/dev/null || true
    aws s3 cp source.zip s3://$BUCKET_NAME/source.zip --profile my-profile
    
    # Create project with S3 source
    aws codebuild create-project \
      --name $PROJECT_NAME \
      --source type=S3,location=$BUCKET_NAME/source.zip \
      --artifacts type=NO_ARTIFACTS \
      --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL,privilegedMode=true \
      --service-role $ROLE_ARN \
      --buildspec buildspec.yml \
      --profile my-profile \
      --region $REGION > /dev/null 2>&1 || echo "Project may already exist"
fi

# Upload updated source
BUCKET_NAME=$(aws codebuild batch-get-projects --names $PROJECT_NAME --profile my-profile --region $REGION --query 'projects[0].source.location' --output text | cut -d'/' -f3)
if [ -n "$BUCKET_NAME" ] && [ "$BUCKET_NAME" != "None" ]; then
    aws s3 cp source.zip s3://$BUCKET_NAME/source.zip --profile my-profile
    aws s3 cp buildspec.yml s3://$BUCKET_NAME/buildspec.yml --profile my-profile
fi

# Start build
echo "Starting CodeBuild..."
BUILD_ID=$(aws codebuild start-build \
  --project-name $PROJECT_NAME \
  --environment-variables-override name=ECR_REPOSITORY_URI,value=$REPOSITORY_URI \
  --profile my-profile \
  --region $REGION \
  --query 'build.id' \
  --output text)

echo "Build started: $BUILD_ID"
echo "Waiting for build to complete (this may take 5-10 minutes)..."

# Wait for build to complete
while true; do
    BUILD_STATUS=$(aws codebuild batch-get-builds \
      --ids $BUILD_ID \
      --profile my-profile \
      --region $REGION \
      --query 'builds[0].buildStatus' \
      --output text)
    
    if [ "$BUILD_STATUS" = "SUCCEEDED" ]; then
        echo "Build completed successfully!"
        break
    elif [ "$BUILD_STATUS" = "FAILED" ] || [ "$BUILD_STATUS" = "FAULT" ] || [ "$BUILD_STATUS" = "TIMED_OUT" ] || [ "$BUILD_STATUS" = "STOPPED" ]; then
        echo "Build failed with status: $BUILD_STATUS"
        echo "Check logs at: https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT_NAME/build/$BUILD_ID"
        exit 1
    fi
    
    echo "Build status: $BUILD_STATUS (waiting...)"
    sleep 10
done

# Cleanup
cd ..
rm -rf "$TEMP_DIR"

# Deploy full stack (including App Runner service)
cd infra
echo "Deploying CDK stack with App Runner service..."
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
echo "  ./scripts/deploy-no-docker.sh                  # Deploy to preview-\$(whoami)"
echo "  ./scripts/deploy-no-docker.sh dev              # Deploy to dev"
echo "  ./scripts/deploy-no-docker.sh prod             # Deploy to production"

