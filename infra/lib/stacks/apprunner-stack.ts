import * as cdk from "aws-cdk-lib";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface AppRunnerStackProps extends cdk.StackProps {
  environment: string;
  cpu?: string; // "1 vCPU" | "2 vCPU" | "4 vCPU"
  memory?: string; // "2 GB" | "4 GB" | "8 GB" | "12 GB"
  port?: number;
  environmentVariables?: { [key: string]: string };
  secretsArn?: string; // ARN of Secrets Manager secret for MySQL credentials
  createService?: boolean;
}

export class AppRunnerStack extends cdk.Stack {
  public readonly serviceUrl: string = "";

  constructor(scope: Construct, id: string, props: AppRunnerStackProps) {
    super(scope, id, props);

    const {
      environment,
      cpu = "1 vCPU",
      memory = "2 GB",
      port = 8080,
      environmentVariables = {},
      secretsArn,
      createService = true,
    } = props;

    // ECR repository for container images
    const repository = new ecr.Repository(this, "Repository", {
      repositoryName: `${id.toLowerCase()}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: "Keep last 25 images",
          maxImageCount: 25,
        },
      ],
    });

    if (createService) {
      // IAM role for App Runner instance
      const instanceRole = new iam.Role(this, "InstanceRole", {
        assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
        description: `App Runner instance role for ${id}`,
      });

      // Grant Secrets Manager access if secrets ARN is provided
      if (secretsArn) {
        const secret = secretsmanager.Secret.fromSecretArn(this, "Secret", secretsArn);
        secret.grantRead(instanceRole);
      }

      // IAM role for App Runner access to ECR
      const accessRole = new iam.Role(this, "AccessRole", {
        assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSAppRunnerServicePolicyForECRAccess"
          ),
        ],
      });

      // App Runner service
      const service = new apprunner.CfnService(this, "Service", {
        serviceName: id,
        sourceConfiguration: {
          authenticationConfiguration: {
            accessRoleArn: accessRole.roleArn,
          },
          autoDeploymentsEnabled: true,
          imageRepository: {
            imageRepositoryType: "ECR",
            imageIdentifier: `${repository.repositoryUri}:latest`,
            imageConfiguration: (() => {
              const config: any = {
                port: port.toString(),
                runtimeEnvironmentVariables: [
                  {
                    name: "ENVIRONMENT",
                    value: environment,
                  },
                  {
                    name: "PORT",
                    value: port.toString(),
                  },
                  ...Object.entries(environmentVariables).map(([name, value]) => ({
                    name,
                    value,
                  })),
                ],
              };
              
              if (secretsArn) {
                config.runtimeEnvironmentSecrets = [
                  {
                    name: "MYSQL_USER",
                    value: `${secretsArn}:MYSQL_USER::`,
                  },
                  {
                    name: "MYSQL_PASSWORD",
                    value: `${secretsArn}:MYSQL_PASSWORD::`,
                  },
                  {
                    name: "MYSQL_HOST",
                    value: `${secretsArn}:MYSQL_HOST::`,
                  },
                  {
                    name: "MYSQL_DATABASE",
                    value: `${secretsArn}:MYSQL_DATABASE::`,
                  },
                ];
              }
              
              return config;
            })(),
          },
        },
        instanceConfiguration: {
          cpu,
          memory,
          instanceRoleArn: instanceRole.roleArn,
        },
        healthCheckConfiguration: {
          protocol: "HTTP",
          path: "/health",
          interval: 10,
          timeout: 5,
          healthyThreshold: 1,
          unhealthyThreshold: 5,
        },
        autoScalingConfigurationArn: undefined, // Use default auto-scaling
      });

      this.serviceUrl = `https://${service.attrServiceUrl}`;

      // Outputs
      new cdk.CfnOutput(this, "ServiceUrl", {
        value: this.serviceUrl,
        description: "App Runner service URL",
        exportName: `${id}-ServiceUrl`,
      });

      new cdk.CfnOutput(this, "ServiceId", {
        value: service.attrServiceId,
        description: "App Runner service ID",
        exportName: `${id}-ServiceId`,
      });
    }

    new cdk.CfnOutput(this, "RepositoryUri", {
      value: repository.repositoryUri,
      description: "ECR repository URI",
      exportName: `${id}-RepositoryUri`,
    });

    // Tags
    cdk.Tags.of(this).add("Stack", "AppRunner");
    cdk.Tags.of(this).add("Environment", environment);
  }
}
