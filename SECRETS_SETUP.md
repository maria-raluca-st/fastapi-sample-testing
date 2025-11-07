# Secrets Setup Guide

This application requires MySQL database credentials stored in AWS Secrets Manager.

## Create Secrets in AWS Secrets Manager

Run the following command to create a secret with MySQL credentials:

```bash
aws secretsmanager create-secret \
  --profile my-profile \
  --region us-east-1 \
  --name FastApiSample/preview-mralucas/mysql \
  --description "MySQL credentials for FastAPI sample application" \
  --secret-string '{
    "MYSQL_USER": "your_mysql_user",
    "MYSQL_PASSWORD": "your_mysql_password",
    "MYSQL_HOST": "your_mysql_host",
    "MYSQL_DATABASE": "your_mysql_database"
  }'
```

## Update CDK Stack with Secrets ARN

After creating the secret, update the CDK stack to use it:

```typescript
// In infra/bin/app.ts, update the AppRunnerStack call:
new AppRunnerStack(app, `FastApiRunner-${environment}`, {
  // ... other props
  secretsArn: "arn:aws:secretsmanager:us-east-1:712844198985:secret:FastApiSample/preview-mralucas/mysql-XXXXXX",
});
```

Or pass it via CDK context:

```bash
cdk deploy --context secretsArn=arn:aws:secretsmanager:us-east-1:712844198985:secret:FastApiSample/preview-mralucas/mysql-XXXXXX
```

## Secret Format

The secret must contain the following keys:
- `MYSQL_USER` - MySQL username
- `MYSQL_PASSWORD` - MySQL password
- `MYSQL_HOST` - MySQL host (e.g., RDS endpoint)
- `MYSQL_DATABASE` - MySQL database name

## Security Notes

- Secrets are automatically injected as environment variables in App Runner
- The App Runner instance role has read permissions to the secret
- Never commit secrets to git
- Rotate secrets regularly for security
