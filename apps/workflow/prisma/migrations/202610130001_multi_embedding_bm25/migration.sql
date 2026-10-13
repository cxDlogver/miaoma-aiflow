-- CreateEnum
CREATE TYPE "KnowledgeIndexStatus" AS ENUM ('BUILDING', 'READY', 'FAILED', 'RETIRED');

-- CreateEnum
CREATE TYPE "DocumentIndexStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeJobKind" AS ENUM ('PROCESS_DOCUMENT', 'DELETE_DOCUMENT', 'DELETE_KNOWLEDGE_BASE', 'DELETE_INDEX');

-- CreateEnum
CREATE TYPE "KnowledgeJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "KnowledgeBaseStatus" ADD VALUE 'NEEDS_REBUILD';

-- AlterTable
ALTER TABLE "knowledge_bases" ADD COLUMN     "activeIndexId" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "embedding_spaces" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelRevision" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "distance" TEXT NOT NULL DEFAULT 'Cosine',
    "queryEncodingVersion" TEXT NOT NULL DEFAULT 'ollama-raw-v1',
    "documentEncodingVersion" TEXT NOT NULL DEFAULT 'ollama-raw-v1',
    "bm25ConfigId" TEXT NOT NULL,
    "collectionName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base_indexes" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "embeddingSpaceId" TEXT NOT NULL,
    "status" "KnowledgeIndexStatus" NOT NULL DEFAULT 'BUILDING',
    "chunkSize" INTEGER NOT NULL,
    "chunkOverlap" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_base_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_indexes" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "knowledgeBaseIndexId" TEXT NOT NULL,
    "status" "DocumentIndexStatus" NOT NULL DEFAULT 'PENDING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_index_jobs" (
    "id" TEXT NOT NULL,
    "kind" "KnowledgeJobKind" NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "documentId" TEXT,
    "indexId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "KnowledgeJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_index_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embedding_spaces_collectionName_key" ON "embedding_spaces"("collectionName");

-- CreateIndex
CREATE INDEX "knowledge_base_indexes_knowledgeBaseId_status_idx" ON "knowledge_base_indexes"("knowledgeBaseId", "status");

-- CreateIndex
CREATE INDEX "document_indexes_knowledgeBaseIndexId_status_idx" ON "document_indexes"("knowledgeBaseIndexId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_indexes_documentId_knowledgeBaseIndexId_key" ON "document_indexes"("documentId", "knowledgeBaseIndexId");

-- CreateIndex
CREATE INDEX "knowledge_index_jobs_status_availableAt_idx" ON "knowledge_index_jobs"("status", "availableAt");

-- CreateIndex
CREATE INDEX "knowledge_index_jobs_knowledgeBaseId_status_idx" ON "knowledge_index_jobs"("knowledgeBaseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_activeIndexId_key" ON "knowledge_bases"("activeIndexId");

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_activeIndexId_fkey" FOREIGN KEY ("activeIndexId") REFERENCES "knowledge_base_indexes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_indexes" ADD CONSTRAINT "knowledge_base_indexes_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base_indexes" ADD CONSTRAINT "knowledge_base_indexes_embeddingSpaceId_fkey" FOREIGN KEY ("embeddingSpaceId") REFERENCES "embedding_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_indexes" ADD CONSTRAINT "document_indexes_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_indexes" ADD CONSTRAINT "document_indexes_knowledgeBaseIndexId_fkey" FOREIGN KEY ("knowledgeBaseIndexId") REFERENCES "knowledge_base_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "embedding_spaces" ADD CONSTRAINT "embedding_space_dimensions_positive" CHECK ("dimensions" > 0);
ALTER TABLE "knowledge_base_indexes" ADD CONSTRAINT "knowledge_index_chunking_valid" CHECK ("chunkSize" > 0 AND "chunkOverlap" >= 0 AND "chunkOverlap" < "chunkSize");
