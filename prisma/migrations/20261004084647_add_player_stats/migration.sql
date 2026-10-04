-- CreateTable
CREATE TABLE "PlayerStats" (
    "playerId" TEXT NOT NULL,
    "matches" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "draws" INTEGER NOT NULL,
    "kd" DOUBLE PRECISION NOT NULL,
    "acs" DOUBLE PRECISION NOT NULL,
    "adr" DOUBLE PRECISION NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "headshotPct" DOUBLE PRECISION NOT NULL,
    "trackerScore" INTEGER NOT NULL,
    "totalMatches" INTEGER NOT NULL,
    "lastMatchAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerStats_pkey" PRIMARY KEY ("playerId")
);

-- CreateIndex
CREATE INDEX "PlayerStats_trackerScore_playerId_idx" ON "PlayerStats"("trackerScore" DESC, "playerId");

-- CreateIndex
CREATE INDEX "PlayerStats_acs_playerId_idx" ON "PlayerStats"("acs" DESC, "playerId");

-- CreateIndex
CREATE INDEX "PlayerStats_kd_playerId_idx" ON "PlayerStats"("kd" DESC, "playerId");

-- CreateIndex
CREATE INDEX "PlayerStats_winRate_playerId_idx" ON "PlayerStats"("winRate" DESC, "playerId");

-- AddForeignKey
ALTER TABLE "PlayerStats" ADD CONSTRAINT "PlayerStats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
