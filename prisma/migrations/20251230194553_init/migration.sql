-- CreateTable
CREATE TABLE "public"."Player" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Match" (
    "id" TEXT NOT NULL,
    "map" TEXT,
    "mode" TEXT,
    "region" TEXT,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlayerMatch" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "team" TEXT,
    "kills" INTEGER,
    "deaths" INTEGER,
    "assists" INTEGER,
    "score" INTEGER,

    CONSTRAINT "PlayerMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_name_tag_key" ON "public"."Player"("name", "tag");

-- CreateIndex
CREATE INDEX "PlayerMatch_playerId_idx" ON "public"."PlayerMatch"("playerId");

-- CreateIndex
CREATE INDEX "PlayerMatch_matchId_idx" ON "public"."PlayerMatch"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerMatch_matchId_playerId_key" ON "public"."PlayerMatch"("matchId", "playerId");

-- AddForeignKey
ALTER TABLE "public"."PlayerMatch" ADD CONSTRAINT "PlayerMatch_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "public"."Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlayerMatch" ADD CONSTRAINT "PlayerMatch_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "public"."Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
