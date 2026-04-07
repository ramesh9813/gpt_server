import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const clearDb = async () => {
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.folder.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.userSettings.deleteMany();
  await prisma.user.deleteMany();
};
