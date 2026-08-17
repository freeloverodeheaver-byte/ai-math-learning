import { z } from "zod";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url().optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DEV_IDENTITY_ENABLED: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.DATABASE_URL === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_URL is required when NODE_ENV is production",
        path: ["DATABASE_URL"],
      });
    }
  });

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return EnvironmentSchema.parse(env);
}
