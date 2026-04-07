import { PrismaClient } from "@prisma/client";
import { env } from "./config";

export const prisma = new PrismaClient();

const maskDatabaseTarget = (databaseUrl: string) => {
  try {
    const url = new URL(databaseUrl);
    const authPart = url.username ? `${url.username}:****@` : "";
    return `${url.protocol}//${authPart}${url.host}${url.pathname}`;
  } catch {
    return databaseUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:****@");
  }
};

export const getDatabaseTarget = () => maskDatabaseTarget(env.DATABASE_URL);

export const verifyDatabaseConnection = async () => {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
};
