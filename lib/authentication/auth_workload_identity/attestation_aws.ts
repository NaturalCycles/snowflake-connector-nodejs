import type { defaultProvider as _defaultProvider } from '@aws-sdk/credential-provider-node';
import type {
  STSClient as _STSClient,
  AssumeRoleCommand as _AssumeRoleCommand,
  GetWebIdentityTokenCommand as _GetWebIdentityTokenCommand,
} from '@aws-sdk/client-sts';
import type { MetadataService as _MetadataService } from '@aws-sdk/ec2-metadata-service';
import type { HttpRequest as _HttpRequest } from '@smithy/protocol-http';
import type { SignatureV4 as _SignatureV4 } from '@smithy/signature-v4';
import type { Sha256 as _Sha256 } from '@aws-crypto/sha256-js';
import Logger from '../../logger';

// AWS / Smithy SDKs are optional peerDependencies in the @naturalcycles/snowflake-sdk fork.
// They're loaded lazily on first WIF use so consumers who don't use AWS workload-identity
// can install the package without pulling in the @aws-sdk/* tree.
type AwsSdk = {
  defaultProvider: typeof _defaultProvider;
  STSClient: typeof _STSClient;
  AssumeRoleCommand: typeof _AssumeRoleCommand;
  GetWebIdentityTokenCommand: typeof _GetWebIdentityTokenCommand;
  MetadataService: typeof _MetadataService;
  HttpRequest: typeof _HttpRequest;
  SignatureV4: typeof _SignatureV4;
  Sha256: typeof _Sha256;
};
let _sdk: AwsSdk | undefined;
function awsSdk(): AwsSdk {
  if (!_sdk) {
    _sdk = {
      defaultProvider: require('@aws-sdk/credential-provider-node').defaultProvider,
      STSClient: require('@aws-sdk/client-sts').STSClient,
      AssumeRoleCommand: require('@aws-sdk/client-sts').AssumeRoleCommand,
      GetWebIdentityTokenCommand: require('@aws-sdk/client-sts').GetWebIdentityTokenCommand,
      MetadataService: require('@aws-sdk/ec2-metadata-service').MetadataService,
      HttpRequest: require('@smithy/protocol-http').HttpRequest,
      SignatureV4: require('@smithy/signature-v4').SignatureV4,
      Sha256: require('@aws-crypto/sha256-js').Sha256,
    };
  }
  return _sdk;
}

export async function getAwsCredentials(region: string, impersonationPath: string[] = []) {
  const { defaultProvider, STSClient, AssumeRoleCommand } = awsSdk();
  Logger().debug('Getting AWS credentials from default provider');
  let credentials = await defaultProvider()();

  for (const roleArn of impersonationPath) {
    Logger().debug(`Getting AWS credentials from impersonation role: ${roleArn}`);
    const stsClient = new STSClient({
      credentials,
      region,
    });
    const command = new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'identity-federation-session',
    });
    const { Credentials } = await stsClient.send(command);
    if (Credentials?.AccessKeyId && Credentials?.SecretAccessKey) {
      credentials = {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      };
    } else {
      throw new Error(`Failed to get credentials from impersonation role ${roleArn}`);
    }
  }

  return credentials;
}

export async function getAwsRegion() {
  if (process.env.AWS_REGION) {
    Logger().debug('Getting AWS region from AWS_REGION');
    return process.env.AWS_REGION; // Lambda
  } else {
    Logger().debug('Getting AWS region from EC2 metadata service');
    const { MetadataService } = awsSdk();
    return new MetadataService().request('/latest/meta-data/placement/region', {}); // EC2
  }
}

export function getStsHostname(region: string) {
  const domain = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `sts.${region}.${domain}`;
}

export async function getAwsAttestationToken(
  useOutboundToken = false,
  impersonationPath?: string[],
) {
  const region = await getAwsRegion();
  const credentials = await getAwsCredentials(region, impersonationPath);

  if (useOutboundToken) {
    return getOutboundWebIdentityToken(region, credentials);
  } else {
    return getCallerIdentityToken(region, credentials);
  }
}

async function getCallerIdentityToken(
  region: string,
  credentials: Awaited<ReturnType<typeof getAwsCredentials>>,
) {
  const { HttpRequest, SignatureV4, Sha256 } = awsSdk();
  const stsHostname = getStsHostname(region);
  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https',
    hostname: stsHostname,
    path: '/',
    headers: {
      host: stsHostname,
      'x-snowflake-audience': 'snowflakecomputing.com',
    },
    query: {
      Action: 'GetCallerIdentity',
      Version: '2011-06-15',
    },
  });
  const signedRequest = await new SignatureV4({
    credentials,
    applyChecksum: false,
    region,
    service: 'sts',
    sha256: Sha256,
  }).sign(request);

  const token = {
    url: `https://${stsHostname}/?Action=GetCallerIdentity&Version=2011-06-15`,
    method: 'POST',
    headers: signedRequest.headers,
  };
  return btoa(JSON.stringify(token));
}

async function getOutboundWebIdentityToken(
  region: string,
  credentials: Awaited<ReturnType<typeof getAwsCredentials>>,
) {
  const { STSClient, GetWebIdentityTokenCommand } = awsSdk();
  const stsClient = new STSClient({ credentials, region });
  const response = await stsClient.send(
    new GetWebIdentityTokenCommand({
      Audience: ['snowflakecomputing.com'],
      SigningAlgorithm: 'ES384',
    }),
  );

  const token = response.WebIdentityToken;
  if (!token) {
    throw new Error('Failed to obtain AWS web identity token from STS');
  }

  return token;
}
