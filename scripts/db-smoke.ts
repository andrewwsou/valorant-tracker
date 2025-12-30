import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.player.count();
  console.log("Player count:", count);
}

main()
  .catch(console.error)
  .finally(async () => prisma.$disconnect());
