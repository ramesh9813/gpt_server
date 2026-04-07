import "./init-env";
import app from "./app";
import { env } from "./lib/config";
import { logger } from "./lib/logger";
import { getDatabaseTarget, verifyDatabaseConnection } from "./lib/prisma";

const externalUrl = process.env.RENDER_EXTERNAL_URL || null;
const isDev = process.env.NODE_ENV !== "production";

const tryListen = (port: number) =>
  new Promise<import("http").Server>((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on("error", reject);
  });

const startServer = async () => {
  const basePort = Number(env.PORT) || 5000;
  let boundPort = basePort;
  let server: import("http").Server | null = null;

  logger.info(
    { url: `http://localhost:${basePort}`, externalUrl },
    "Starting backend server"
  );

  try {
    await verifyDatabaseConnection();
    logger.info(
      { database: getDatabaseTarget() },
      "Database connected successfully"
    );
  } catch (err) {
    logger.error(
      { err, database: getDatabaseTarget() },
      "Database connection failed"
    );
    process.exit(1);
  }

  const maxRetries = isDev ? 3 : 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      server = await tryListen(boundPort);
      break;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EADDRINUSE" || attempt === maxRetries) {
        logger.error(
          { err: error, port: boundPort },
          "Failed to start backend server"
        );
        process.exit(1);
      }

      logger.warn(
        { port: boundPort },
        "Port is already in use, trying the next available port"
      );
      boundPort += 1;
    }
  }

  if (!server) {
    logger.error({ port: basePort }, "No available port found");
    process.exit(1);
  }

  logger.info(
    { url: `http://localhost:${boundPort}`, externalUrl },
    "Backend server is running"
  );
};

startServer().catch((err) => {
  logger.error({ err }, "Server startup failed");
  process.exit(1);
});
