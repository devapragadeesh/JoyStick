import { buildServer } from "./server.js";
import { config } from "./config.js";

const app = buildServer({ logger: false });

async function main(): Promise<void> {
  try {
    await app.listen({ port: config.port, host: config.host });
    process.stdout.write(
      `joystick sidecar → http://${config.host}:${config.port}  (db: ${config.dbPath})\n`,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      process.stderr.write(
        `joystick: port ${config.port} is already in use. Another sidecar may be running.\n`,
      );
      process.exit(1);
    }
    throw err;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

void main();
