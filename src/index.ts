import "dotenv/config";
import app from "./app";
import { env } from "./lib/config";
import { logger } from "./lib/logger";

app.listen(Number(env.PORT), () => {
  logger.info(`Server listening on port ${env.PORT}`);
});