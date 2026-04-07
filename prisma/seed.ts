import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const run = async () => {
  const passwordHash = await bcrypt.hash("DemoPass123!", 10);

  const user = await prisma.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: {
      email: "demo@example.com",
      passwordHash,
      name: "Demo User",
      role: "user",
      settings: { create: {} }
    }
  });

  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "Getting started"
    }
  });

  await prisma.message.createMany({
    data: [
      {
        conversationId: conversation.id,
        role: "SYSTEM",
        content: "You are ChatUI, a helpful assistant.",
        status: "COMPLETE"
      },
      {
        conversationId: conversation.id,
        role: "USER",
        content: "Hello! What can you do?",
        status: "COMPLETE"
      },
      {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content:
          "I can answer questions, brainstorm, and help you draft content. Try asking me anything.",
        status: "COMPLETE"
      }
    ]
  });
};

run()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
