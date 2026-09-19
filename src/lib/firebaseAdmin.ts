import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { logger } from "./logger";

let isFirebaseConfigured = false;

const buildCredential = () => {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const absolutePath = path.resolve(serviceAccountPath);
    if (fs.existsSync(absolutePath)) {
      const raw = fs.readFileSync(absolutePath, "utf8");
      return admin.credential.cert(JSON.parse(raw));
    }
    logger.warn(
      { path: absolutePath },
      "FIREBASE_SERVICE_ACCOUNT_PATH specified but file does not exist"
    );
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    });
  }

  return null;
};

try {
  const credential = buildCredential();
  if (credential) {
    if (!admin.apps.length) {
      admin.initializeApp({ credential });
    }
    isFirebaseConfigured = true;
    logger.info("Firebase Admin SDK initialized successfully");
  } else {
    logger.warn(
      "Firebase credentials not provided. Google authentication will be disabled."
    );
  }
} catch (err) {
  logger.warn(
    { err },
    "Failed to initialize Firebase Admin SDK. Google authentication will be disabled."
  );
}

export const firebaseAdmin = isFirebaseConfigured ? admin : null;
export { isFirebaseConfigured };

