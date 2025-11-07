#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AppRunnerStack } from "../lib/stacks/apprunner-stack";
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

const environment =
  app.node.tryGetContext("environment") || getDefaultEnvironment();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION || "us-east-1";
const createService = app.node.tryGetContext("createService") !== "false";
const secretsArn = app.node.tryGetContext("secretsArn");

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

// Global tags
cdk.Tags.of(app).add("Project", "FastApiSample");
cdk.Tags.of(app).add("ManagedBy", "CDK");
cdk.Tags.of(app).add("Environment", environment);
