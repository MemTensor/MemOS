import { z } from 'zod';

const PRODUCTION_API_URL = 'https://lite.accomplish.ai';

const desktopConfigSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .default(PRODUCTION_API_URL),
});

type DesktopConfig = z.infer<typeof desktopConfigSchema>;

let cachedConfig: DesktopConfig | null = null;

export function getDesktopConfig(): DesktopConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = desktopConfigSchema.safeParse({
    apiUrl: process.env.ACCOMPLISH_API_URL,
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join('; ');
    throw new Error(`Invalid desktop configuration: ${message}`);
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}
