#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AppRunnerStack } from "../lib/stacks/apprunner-stack";
import { PipelineStack } from "../lib/pipeline-stack";
import { execSync } from "child_process";

const app = new cdk.App();

const getDefaultEnvironment = (): string => {
  try {
    const username = process.env.USER || execSync("whoami").toString().trim();
    return `preview-${username}`;
  } catch {
    return "preview-local";
  }
};

// Get context values
const codeConnectionArn =
  app.node.tryGetContext("codeConnectionArn") ||
  process.env.CODE_CONNECTION_ARN ||
  "";
const repositoryName =
  app.node.tryGetContext("repositoryName") ||
  process.env.REPOSITORY_NAME ||
  "maria-raluca-st/fastapi-sample-testing";
const branchName =
  app.node.tryGetContext("branchName") ||
  process.env.BRANCH_NAME ||
  "main";
const pipelineOnly = app.node.tryGetContext("pipelineOnly") === "true";

const environment =
  app.node.tryGetContext("environment") || getDefaultEnvironment();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION || "us-east-1";
const createService = app.node.tryGetContext("createService") !== "false";
const secretsArn = app.node.tryGetContext("secretsArn");

// Create per-environment stacks (only if not pipeline-only mode)
if (!pipelineOnly) {
  // For preview environments (preview-*), create single stack
  if (environment.startsWith("preview-")) {
    new AppRunnerStack(app, `FastApiRunner-${environment}`, {
      env: { account, region },
      environment,
      cpu: "1 vCPU",
      memory: "2 GB",
      port: 8080,
      environmentVariables: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
      secretsArn,
      createService,
      description: `App Runner service for FastAPI sample - ${environment}`,
    });
  } else {
    // For dev/prod environments, create stacks
    const environments = ["dev", "prod"];
    for (const env of environments) {
      new AppRunnerStack(app, `FastApiRunner-${env}`, {
        env: { account, region },
        environment: env,
        cpu: "1 vCPU",
        memory: "2 GB",
        port: 8080,
        environmentVariables: {
          NODE_ENV: "production",
          LOG_LEVEL: "info",
        },
        createService: true,
        description: `App Runner service for FastAPI sample - ${env}`,
      });
    }
  }
}

// Create pipeline stack (only if CodeConnection ARN is provided)
if (codeConnectionArn) {
  new PipelineStack(app, "FastApiSamplePipelineStack", {
    env: { account, region },
    description: "CI/CD Pipeline for FastAPI Sample",
    codeConnectionArn,
    repositoryName,
    branchName,
  });
} else if (!pipelineOnly) {
  console.warn(
    "⚠️  CodeConnection ARN not provided. Pipeline stack will not be created.",
  );
  console.warn(
    "   Create connection: aws codestar-connections create-connection --provider-type GitHub",
  );
}

// Global tags
cdk.Tags.of(app).add("Project", "FastApiSample");
cdk.Tags.of(app).add("ManagedBy", "CDK");
if (!pipelineOnly) {
  cdk.Tags.of(app).add("Environment", environment);
}
