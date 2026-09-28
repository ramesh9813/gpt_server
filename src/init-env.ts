import dotenv from "dotenv";

// Do NOT override real environment values (Render injects PORT, DATABASE_URL
// and secrets at runtime). Local .env only fills in missing keys.
dotenv.config({ override: false });
