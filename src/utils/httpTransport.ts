import type { HttpTransportConfig } from 'viem';

export function authHttpConfig(accessToken?: string): HttpTransportConfig | undefined {
  if (!accessToken) return undefined;
  return {
    fetchOptions: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  } as HttpTransportConfig;
}

