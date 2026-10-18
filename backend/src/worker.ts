import { startWorker } from "./outbox";

console.log("outbox worker started");
const stop = startWorker();
process.on("SIGINT", () => {
  stop();
  setTimeout(() => process.exit(0), 1500);
});
