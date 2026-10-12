UPDATE "ModelProvider"
SET
  "enabled" = true,
  "baseUrl" = COALESCE(NULLIF("baseUrl", ''), 'https://openrouter.ai/api/v1'),
  "apiKeyEnvName" = COALESCE(NULLIF("apiKeyEnvName", ''), 'OPENROUTER_API_KEY'),
  "updatedAt" = NOW()
WHERE "name" = 'OpenRouter Free Pool';

UPDATE "ModelProvider"
SET
  "enabled" = true,
  "baseUrl" = COALESCE(NULLIF("baseUrl", ''), 'https://api.deepseek.com'),
  "apiKeyEnvName" = COALESCE(NULLIF("apiKeyEnvName", ''), 'DEEPSEEK_API_KEY'),
  "updatedAt" = NOW()
WHERE "name" = 'DeepSeek Coder API';

UPDATE "ModelProvider"
SET
  "enabled" = true,
  "baseUrl" = COALESCE(NULLIF("baseUrl", ''), 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  "apiKeyEnvName" = COALESCE(NULLIF("apiKeyEnvName", ''), 'QWEN_API_KEY'),
  "updatedAt" = NOW()
WHERE "name" = 'Qwen API Coder';

UPDATE "ModelProvider"
SET
  "enabled" = true,
  "baseUrl" = COALESCE(NULLIF("baseUrl", ''), 'https://api.openai.com/v1'),
  "apiKeyEnvName" = COALESCE(NULLIF("apiKeyEnvName", ''), 'OPENAI_API_KEY'),
  "updatedAt" = NOW()
WHERE "name" = 'Premium Architecture Reviewer';
