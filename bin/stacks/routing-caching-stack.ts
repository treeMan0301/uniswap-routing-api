import * as aws_events from '@aws-cdk/aws-events';
import * as aws_events_targets from '@aws-cdk/aws-events-targets';
import * as aws_iam from '@aws-cdk/aws-iam';
import * as aws_lambda from '@aws-cdk/aws-lambda';
import * as aws_lambda_nodejs from '@aws-cdk/aws-lambda-nodejs';
import * as aws_s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import { Construct, Duration } from '@aws-cdk/core';
import * as path from 'path';
import dotenv from 'dotenv';
import { PolicyStatement } from '@aws-cdk/aws-iam';
dotenv.config()

export interface RoutingCachingStackProps extends cdk.NestedStackProps {
  stage: string;
  route53Arn?: string;
  pinata_key: string;
  pinata_secret: string;
  hosted_zone: string;
}
export class RoutingCachingStack extends cdk.NestedStack {
  public readonly poolCacheBucket: aws_s3.Bucket;
  public readonly poolCacheKey: string;
  public readonly tokenListCacheBucket: aws_s3.Bucket;

  constructor(scope: Construct, name: string, props: RoutingCachingStackProps) {
    super(scope, name, props);

    this.poolCacheBucket = new aws_s3.Bucket(this, 'PoolCacheBucket');
    this.poolCacheKey = 'poolCache.json';

    const {
      stage,
      route53Arn,
      pinata_key,
      pinata_secret,
      hosted_zone
    } = props;
  
    const lambdaRole = new aws_iam.Role(this, 'RoutingLambdaRole', {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccess'),
      ],
    });

    lambdaRole.addToPolicy(new PolicyStatement({
      resources: ['*'], 
      actions: ['sts:AssumeRole']
    }))

    const region = cdk.Stack.of(this).region;

    const poolCachingLambda = new aws_lambda_nodejs.NodejsFunction(
      this,
      'PoolCacheLambda',
      {
        role: lambdaRole,
        runtime: aws_lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, '../../lib/cron/cache-pools.ts'),
        handler: 'handler',
        timeout: Duration.seconds(600),
        memorySize: 1024,
        bundling: {
          minify: true,
          sourceMap: true,
        },
        layers: [
          aws_lambda.LayerVersion.fromLayerVersionArn(
            this,
            'InsightsLayerPools',
            `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`
          ),
        ],
        tracing: aws_lambda.Tracing.ACTIVE,
        environment: {
          POOL_CACHE_BUCKET: this.poolCacheBucket.bucketName,
          POOL_CACHE_KEY: this.poolCacheKey,
        },
      }
    );

    this.poolCacheBucket.grantReadWrite(poolCachingLambda);

    const ipfsPoolCachingLambda = new aws_lambda_nodejs.NodejsFunction(
      this,
      'IpfsPoolCacheLambda',
      {
        role: lambdaRole,
        runtime: aws_lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, '../../lib/cron/cache-pools-ipfs.ts'),
        handler: 'handler',
        timeout: Duration.seconds(600),
        memorySize: 1024,
        bundling: {
          minify: true,
          sourceMap: true,
        },
        layers: [
          aws_lambda.LayerVersion.fromLayerVersionArn(
            this,
            'InsightsLayerPoolsIPFS',
            `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`
          ),
        ],
        tracing: aws_lambda.Tracing.ACTIVE,
        environment: {
          PINATA_API_KEY: pinata_key,
          PINATA_API_SECRET:  pinata_secret,
          ROLE_ARN: route53Arn!,
          HOSTED_ZONE: hosted_zone,
          STAGE: stage
        },
      }
    );

    new aws_events.Rule(this, 'SchedulePoolCache', {
      schedule: aws_events.Schedule.rate(Duration.minutes(2)),
      targets: [new aws_events_targets.LambdaFunction(poolCachingLambda), new aws_events_targets.LambdaFunction(ipfsPoolCachingLambda)],
    });

    this.tokenListCacheBucket = new aws_s3.Bucket(this, 'TokenListCacheBucket');

    const tokenListCachingLambda = new aws_lambda_nodejs.NodejsFunction(
      this,
      'TokenListCacheLambda',
      {
        role: lambdaRole,
        runtime: aws_lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, '../../lib/cron/cache-token-lists.ts'),
        handler: 'handler',
        timeout: Duration.seconds(180),
        memorySize: 256,
        bundling: {
          minify: true,
          sourceMap: true,
        },
        layers: [
          aws_lambda.LayerVersion.fromLayerVersionArn(
            this,
            'InsightsLayerTokenList',
            `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`
          ),
        ],
        tracing: aws_lambda.Tracing.ACTIVE,
        environment: {
          TOKEN_LIST_CACHE_BUCKET: this.tokenListCacheBucket.bucketName,
        },
      }
    );

    this.tokenListCacheBucket.grantReadWrite(tokenListCachingLambda);

    new aws_events.Rule(this, 'ScheduleTokenListCache', {
      schedule: aws_events.Schedule.rate(Duration.minutes(2)),
      targets: [new aws_events_targets.LambdaFunction(tokenListCachingLambda)],
    });
  }
}
