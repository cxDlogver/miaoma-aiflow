-- 旧索引不兼容；保留原始文本供用户触发重建。此迁移与新增枚举分开提交。
UPDATE "knowledge_bases" SET "status" = 'NEEDS_REBUILD', "chunkCount" = 0 WHERE "activeIndexId" IS NULL;
UPDATE "documents" SET "status" = 'ERROR', "chunkCount" = 0, "processedAt" = NULL, "errorMessage" = '索引协议已升级，请在知识库设置中重建索引' WHERE "knowledgeBaseId" IN (SELECT "id" FROM "knowledge_bases" WHERE "activeIndexId" IS NULL);
