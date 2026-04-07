import "./init-env";
import app from "./app";
import { env } from "./lib/config";
import { logger } from "./lib/logger";
import { getDatabaseTarget, verifyDatabaseConnection } from "./lib/prisma";

const localUrl = `http://localhost:${env.PORT}`;
const externalUrl = process.env.RENDER_EXTERNAL_URL || null;

const startServer = async () => {
  logger.info({ url: localUrl, externalUrl }, "Starting backend server");

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

  app.listen(Number(env.PORT), () => {
    logger.info(
      { url: localUrl, externalUrl },
      "Backend server is running"
    );
  });
};

startServer().catch((err) => {
  logger.error({ err }, "Server startup failed");
  process.exit(1);
});
