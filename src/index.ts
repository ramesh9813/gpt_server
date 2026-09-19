import "./init-env";
import app from "./app";
import { env } from "./lib/config";
import { logger } from "./lib/logger";
import { getDatabaseTarget, verifyDatabaseConnection } from "./lib/prisma";

const externalUrl = process.env.RENDER_EXTERNAL_URL || null;
const isDev = process.env.NODE_ENV !== "production";

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled Rejection at Promise");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught Exception thrown");
});

const tryListen = (port: number) =>
  new Promise<import("http").Server>((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve(server));
    server.on("error", reject);
  });

const connectDatabaseWithRetry = async (maxAttempts = 5, delayMs = 3000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await verifyDatabaseConnection();
      logger.info(
        { database: getDatabaseTarget(), attempt },
        "Database connected successfully"
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, database: getDatabaseTarget(), attempt, maxAttempts },
        `Database connection attempt ${attempt}/${maxAttempts} failed`
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        logger.error(
          { err, database: getDatabaseTarget() },
          "Database connection failed after all retries. The server will keep running and retry on subsequent requests."
        );
      }
    }
  }
  return false;
};

const startServer = async () => {
  const basePort = Number(env.PORT) || 5000;
  let boundPort = basePort;
  let server: import("http").Server | null = null;

  logger.info(
    { url: `http://localhost:${basePort}`, externalUrl },
    "Starting backend server"
  );

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

  // Attempt database connection with retries so waking/cold databases don't crash the server
  connectDatabaseWithRetry().catch((err) => {
    logger.error({ err }, "Error during database connection retry loop");
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Server startup failed");
  process.exit(1);
});

