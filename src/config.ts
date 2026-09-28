import { z } from "zod";

const envSchema = z.object({
  BACKLOG_BASE_URL: z
    .string()
    .min(1, "BACKLOG_BASE_URL is required")
    .url("BACKLOG_BASE_URL must be a valid URL, e.g. https://yourspace.backlog.jp"),
  BACKLOG_API_KEY: z.string().min(1, "BACKLOG_API_KEY is required"),
  BACKLOG_PROJECT_KEY: z.string().min(1, "BACKLOG_PROJECT_KEY is required"),
  PORT: z.coerce.number().int().positive().default(3000),
});

export interface Config {
  baseUrl: string;
  apiKey: string;
  projectKey: string;
  port: number;
}

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report which variables are missing/invalid, never their values.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(
      `Configuration error. Check your .env file (see .env.example):\n${problems}`
    );
    process.exit(1);
  }
  return {
    baseUrl: parsed.data.BACKLOG_BASE_URL.replace(/\/+$/, ""),
    apiKey: parsed.data.BACKLOG_API_KEY,
    projectKey: parsed.data.BACKLOG_PROJECT_KEY,
    port: parsed.data.PORT,
  };
}
