import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import { Construct } from "constructs";
import { CodeBuildRole, ArtifactsBucket } from "./shared-constructs";

export interface PipelineStackProps extends cdk.StackProps {
  codeConnectionArn: string;
  repositoryName: string;
  branchName: string;
}

export class PipelineStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly artifactsBucket: s3.Bucket;
  private readonly props: PipelineStackProps;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    this.props = props;

    // Create artifacts bucket
    const artifactsBucketConstruct = new ArtifactsBucket(this, "ArtifactsBucket");
    this.artifactsBucket = artifactsBucketConstruct.bucket;

    // Create SNS topic for notifications
    const notificationTopic = new sns.Topic(this, "PipelineNotifications", {
      displayName: "FastAPISample Pipeline Notifications",
    });

    // Create CodeBuild roles
    const qualityRole = new CodeBuildRole(this, "QualityRole", {
      allowSecretsManager: true,
      allowS3Artifacts: true,
    });

    const buildRole = new CodeBuildRole(this, "BuildRole", {
      allowSecretsManager: true,
      allowS3Artifacts: true,
      allowECR: true,
      allowCloudFormation: true,
      allowCdkBootstrap: true,
    });

    const deployRole = new CodeBuildRole(this, "DeployRole", {
      allowSecretsManager: true,
      allowS3Artifacts: true,
      allowCloudFormation: true,
      allowCdkBootstrap: true,
      allowECR: true,
      allowAppRunner: true,
    });

    // Create CodeBuild projects
    const updatePipelineProject = this.createUpdatePipelineProject(deployRole.role);
    const lintTypeSecretsProject = this.createLintTypeSecretsProject(qualityRole.role);
    const unitTestsProject = this.createUnitTestsProject(qualityRole.role);
    const depScanProject = this.createDepScanProject(qualityRole.role);
    const dockerBuildProject = this.createDockerBuildProject(buildRole.role);
    const iacSynthProject = this.createIacSynthProject(buildRole.role);
    const deployAppRunnerProject = this.createDeployAppRunnerProject(deployRole.role);

    // Define pipeline artifacts
    const artifacts = {
      source: new codepipeline.Artifact("SourceOutput"),
      lint: new codepipeline.Artifact("LintTypeSecretsOutput"),
      unit: new codepipeline.Artifact("UnitTestsOutput"),
      depScan: new codepipeline.Artifact("DepScanOutput"),
      dockerImage: new codepipeline.Artifact("DockerImageOutput"),
      iacSynth: new codepipeline.Artifact("IacSynthOutput"),
    };

    const [owner, repo] = props.repositoryName.split("/");

    // Define pipeline stages
    const stages: codepipeline.StageProps[] = [
      {
        stageName: "Source",
        actions: [
          new codepipeline_actions.CodeStarConnectionsSourceAction({
            actionName: "Source",
            owner,
            repo,
            branch: props.branchName,
            connectionArn: props.codeConnectionArn,
            output: artifacts.source,
            triggerOnPush: true,
          }),
        ],
      },
      {
        stageName: "UpdatePipeline",
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: "UpdatePipeline",
            project: updatePipelineProject,
            input: artifacts.source,
          }),
        ],
      },
      {
        stageName: "Quality",
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: "LintTypeSecrets",
            project: lintTypeSecretsProject,
            input: artifacts.source,
            outputs: [artifacts.lint],
          }),
          new codepipeline_actions.CodeBuildAction({
            actionName: "UnitTests",
            project: unitTestsProject,
            input: artifacts.source,
            outputs: [artifacts.unit],
          }),
          new codepipeline_actions.CodeBuildAction({
            actionName: "DepScan",
            project: depScanProject,
            input: artifacts.source,
            outputs: [artifacts.depScan],
          }),
        ],
      },
      {
        stageName: "Build",
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: "DockerBuild",
            project: dockerBuildProject,
            input: artifacts.source,
            outputs: [artifacts.dockerImage],
          }),
          new codepipeline_actions.CodeBuildAction({
            actionName: "IacSynth",
            project: iacSynthProject,
            input: artifacts.source,
            outputs: [artifacts.iacSynth],
          }),
        ],
      },
      {
        stageName: "DeployDev",
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: "DeployAppRunnerDev",
            project: deployAppRunnerProject,
            input: artifacts.source,
            extraInputs: [artifacts.dockerImage, artifacts.iacSynth],
            outputs: [new codepipeline.Artifact("AppRunnerDeployDev")],
            environmentVariables: {
              ENVIRONMENT: { value: "dev" },
            },
            runOrder: 1,
          }),
        ],
      },
      {
        stageName: "ManualApproval",
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: "ApproveProductionDeployment",
            additionalInformation: "Review dev deployment and approve production deployment",
          }),
        ],
      },
      {
        stageName: "DeployProd",
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: "DeployAppRunnerProd",
            project: deployAppRunnerProject,
            input: artifacts.source,
            extraInputs: [artifacts.dockerImage, artifacts.iacSynth],
            outputs: [new codepipeline.Artifact("AppRunnerDeployProd")],
            environmentVariables: {
              ENVIRONMENT: { value: "prod" },
            },
            runOrder: 1,
          }),
        ],
      },
    ];

    // Create pipeline
    this.pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: "FastAPISamplePipeline",
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: this.artifactsBucket,
      stages,
    });

    // Add CloudWatch alarms
    this.createPipelineAlarms(notificationTopic);

    // Subscribe to notifications
    this.pipeline.notifyOnExecutionStateChange(
      "PipelineExecutionNotifications",
      notificationTopic,
    );

    // Outputs
    new cdk.CfnOutput(this, "PipelineName", {
      value: this.pipeline.pipelineName,
      description: "CodePipeline Name",
    });

    new cdk.CfnOutput(this, "BuildRoleArn", {
      value: buildRole.role.roleArn,
      description: "CodeBuild Build Role ARN (for CDK bootstrap trust)",
      exportName: `${this.stackName}-BuildRoleArn`,
    });

    new cdk.CfnOutput(this, "DeployRoleArn", {
      value: deployRole.role.roleArn,
      description: "CodeBuild Deploy Role ARN (for CDK bootstrap trust)",
      exportName: `${this.stackName}-DeployRoleArn`,
    });
  }

  private createUpdatePipelineProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "UpdatePipelineProject", {
      projectName: "FastAPISample-UpdatePipeline",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/update_pipeline.yml"),
      environmentVariables: {
        CODE_CONNECTION_ARN: { value: this.props.codeConnectionArn },
        REPOSITORY_NAME: { value: this.props.repositoryName },
        BRANCH_NAME: { value: this.props.branchName },
      },
    });
  }

  private createLintTypeSecretsProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "LintTypeSecretsProject", {
      projectName: "FastAPISample-LintTypeSecrets",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/lint_type_secrets.yml"),
    });
  }

  private createUnitTestsProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "UnitTestsProject", {
      projectName: "FastAPISample-UnitTests",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/unit_tests.yml"),
    });
  }

  private createDepScanProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "DepScanProject", {
      projectName: "FastAPISample-DepScan",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/dep_scan.yml"),
    });
  }

  private createDockerBuildProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "DockerBuildProject", {
      projectName: "FastAPISample-DockerBuild",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/docker_build.yml"),
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        AWS_ACCOUNT_ID: { value: this.account },
      },
    });
  }

  private createIacSynthProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "IacSynthProject", {
      projectName: "FastAPISample-IacSynth",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/iac_synth.yml"),
    });
  }

  private createDeployAppRunnerProject(role: iam.Role): codebuild.PipelineProject {
    return new codebuild.PipelineProject(this, "DeployAppRunnerProject", {
      projectName: "FastAPISample-DeployAppRunner",
      role,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspecs/deploy_apprunner.yml"),
      environmentVariables: {
        AWS_DEFAULT_REGION: { value: this.region },
        AWS_ACCOUNT_ID: { value: this.account },
      },
    });
  }

  private createPipelineAlarms(topic: sns.Topic): void {
    const pipelineFailures = new cloudwatch.Alarm(this, "PipelineFailures", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodePipeline",
        metricName: "FailedExecutions",
        dimensionsMap: {
          PipelineName: this.pipeline.pipelineName,
        },
        statistic: "Sum",
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Pipeline execution failures",
    });

    pipelineFailures.addAlarmAction(
      new cloudwatch_actions.SnsAction(topic),
    );
  }
}

