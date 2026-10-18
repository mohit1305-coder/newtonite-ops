export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://app:app@127.0.0.1:5434/ops",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  port: Number(process.env.PORT ?? 3000),
  // Run the outbox worker inside the API process (handy for local dev).
  // In production run `npm run worker` separately and set EMBED_WORKER=false.
  embedWorker: process.env.EMBED_WORKER !== "false",
};
