import fs from "fs";
import path from "path";
import admin from "firebase-admin";

const buildCredential = () => {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const absolutePath = path.resolve(serviceAccountPath);
    const raw = fs.readFileSync(absolutePath, "utf8");
    return admin.credential.cert(JSON.parse(raw));
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

  throw new Error(
    "Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
  );
};

if (!admin.apps.length) {
  const credential = buildCredential();
  admin.initializeApp({ credential });
}

export const firebaseAdmin = admin;
