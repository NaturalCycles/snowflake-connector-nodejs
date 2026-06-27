import type { GoogleAuth as _GoogleAuth, Impersonated as _Impersonated } from 'google-auth-library';
import Logger from '../../logger';

export const SNOWFLAKE_AUDIENCE = 'snowflakecomputing.com';

export async function getGcpAttestationToken(impersonationPath?: string[]) {
  // google-auth-library is an optional peer in the @naturalcycles/snowflake-sdk fork; load lazily.
  const { GoogleAuth, Impersonated } = require('google-auth-library') as {
    GoogleAuth: typeof _GoogleAuth;
    Impersonated: typeof _Impersonated;
  };
  const auth = new GoogleAuth();

  if (impersonationPath) {
    Logger().debug(
      `Getting GCP auth token from impersonation path: ${impersonationPath.join(', ')}`,
    );
    const impersonated = new Impersonated({
      sourceClient: await auth.getClient(),
      targetPrincipal: impersonationPath[impersonationPath.length - 1],
      delegates: impersonationPath.slice(0, -1),
    });
    return await impersonated.fetchIdToken(SNOWFLAKE_AUDIENCE);
  }

  Logger().debug('Getting GCP auth token from default credentials');
  const client = await auth.getIdTokenClient(SNOWFLAKE_AUDIENCE);
  return await client.idTokenProvider.fetchIdToken(SNOWFLAKE_AUDIENCE);
}
