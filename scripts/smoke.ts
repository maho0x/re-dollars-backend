const baseUrl = (process.env.SMOKE_BASE_URL || process.argv[2] || 'http://127.0.0.1:13032').replace(/\/$/, '');

async function expectJson(path: string, predicate: (data: any) => boolean) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!predicate(data)) {
    throw new Error(`${path} returned an unexpected payload: ${JSON.stringify(data).slice(0, 300)}`);
  }
}

await expectJson('/health', (data) => data?.status === true && data?.name === 're-dollars-backend-next');
await expectJson('/ready', (data) => data?.status === true && data?.ready === true);
await expectJson('/api/v1/ready', (data) => data?.status === true && data?.ready === true);
await expectJson('/api/v1/openapi.json', (data) => data?.openapi === '3.1.0');
await expectJson('/api/openapi.json', (data) => data?.servers?.[0]?.url === '/api/v1');

console.info(`Smoke check passed for ${baseUrl}`);
