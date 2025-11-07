import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface CodeBuildRoleProps {
  allowSecretsManager?: boolean;
  allowS3Artifacts?: boolean;
  allowCloudFormation?: boolean;
  allowCdkBootstrap?: boolean;
  allowECR?: boolean;
  allowAppRunner?: boolean;
  additionalPolicies?: iam.PolicyStatement[];
}

export class CodeBuildRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CodeBuildRoleProps = {}) {
    super(scope, id);

    const {
      allowSecretsManager = false,
      allowS3Artifacts = false,
      allowCloudFormation = false,
      allowCdkBootstrap = false,
      allowECR = false,
      allowAppRunner = false,
      additionalPolicies = [],
    } = props;

    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: `CodeBuild role for ${id}`,
    });

    // Secrets Manager access
    if (allowSecretsManager) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "secretsmanager:GetSecretValue",
            "secretsmanager:DescribeSecret",
          ],
          resources: ["*"],
        }),
      );
    }

    // S3 artifacts access
    if (allowS3Artifacts) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          resources: ["*"],
        }),
      );
    }

    // CloudFormation access
    if (allowCloudFormation) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStackResources",
            "cloudformation:GetTemplate",
            "cloudformation:CreateStack",
            "cloudformation:UpdateStack",
            "cloudformation:DeleteStack",
            "cloudformation:CreateChangeSet",
            "cloudformation:ExecuteChangeSet",
            "cloudformation:DescribeChangeSet",
          ],
          resources: ["*"],
        }),
      );
    }

    // CDK Bootstrap access
    if (allowCdkBootstrap) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "cloudformation:*",
            "s3:*",
            "iam:PassRole",
            "iam:GetRole",
            "iam:CreateRole",
            "iam:AttachRolePolicy",
            "iam:PutRolePolicy",
            "ssm:GetParameter",
            "ssm:PutParameter",
          ],
          resources: ["*"],
        }),
      );
    }

    // ECR access
    if (allowECR) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:PutImage",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
          ],
          resources: ["*"],
        }),
      );
    }

    // App Runner access
    if (allowAppRunner) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "apprunner:CreateService",
            "apprunner:UpdateService",
            "apprunner:DescribeService",
            "apprunner:ListServices",
            "apprunner:ListOperations",
          ],
          resources: ["*"],
        }),
      );
    }

    // Additional policies
    additionalPolicies.forEach((policy) => {
      this.role.addToPolicy(policy);
    });
  }
}

export class ArtifactsBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const account = cdk.Stack.of(this).account;
    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: `fastapisample-pipeline-artifacts-${account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
  }
}

