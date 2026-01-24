import { execSync } from "child_process";
import path from "path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./test.db";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "test_access";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test_refresh";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test_key";
process.env.OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "http://localhost:9999";
process.env.OPENROUTER_MODEL_DEFAULT =
  process.env.OPENROUTER_MODEL_DEFAULT || "test-model";
process.env.APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173";

try {
  execSync("npx prisma db push --skip-generate", {
    cwd: path.resolve(process.cwd()),
    stdio: "ignore"
  });
} catch {
  // ignore setup errors for minimal test config
}