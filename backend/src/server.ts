import { buildApp } from "./app";
import { config } from "./config";
import { migrate } from "./migrate";
import { startWorker } from "./outbox";

await migrate();
const app = await buildApp();
if (config.embedWorker) startWorker();
await app.listen({ port: config.port, host: "0.0.0.0" });
