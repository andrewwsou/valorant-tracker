/*
  Warnings:

  - A unique constraint covering the columns `[puuid]` on the table `Player` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."Match" ADD COLUMN     "roundsBlue" INTEGER,
ADD COLUMN     "roundsRed" INTEGER;

-- AlterTable
ALTER TABLE "public"."Player" ADD COLUMN     "puuid" TEXT;

-- AlterTable
ALTER TABLE "public"."PlayerMatch" ADD COLUMN     "agentIcon" TEXT,
ADD COLUMN     "bodyshots" INTEGER,
ADD COLUMN     "damage" INTEGER,
ADD COLUMN     "headshots" INTEGER,
ADD COLUMN     "legshots" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Player_puuid_key" ON "public"."Player"("puuid");
