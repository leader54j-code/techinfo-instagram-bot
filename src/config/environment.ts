const requiredInProduction = [
  'OPENAI_API_KEY',
  'INSTAGRAM_USER_ID',
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_EXPECTED_USERNAME',
  'PUBLIC_BASE_URL',
  'ADMIN_API_KEY',
] as const;

export function validateEnvironment(input: Record<string, unknown>): Record<string, unknown> {
  if (!input.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (input.NODE_ENV === 'production') {
    for (const key of requiredInProduction) {
      if (!input[key]) throw new Error(`${key} is required in production`);
    }
  }
  const limit = Number(input.MAX_DAILY_POSTS ?? 3);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error('MAX_DAILY_POSTS must be an integer between 1 and 25');
  }
  return input;
}
