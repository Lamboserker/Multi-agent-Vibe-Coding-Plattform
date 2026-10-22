export type IntegrationPlatform = 'win32' | 'darwin' | 'linux'
export type GrantGroup = 'read' | 'browser' | 'desktop' | 'code' | 'generate' | 'write'
export interface IntegrationField {
  key: string
  label: string
  type: 'text' | 'secret' | 'directory' | 'url' | 'port'
  required: boolean
  target: 'env' | 'arg' | 'url' | 'header'
  defaultValue?: string
}
export interface McpPreset {
  id: string
  version: string
  title: string
  description: string
  category: string
  publisher: string
  source: string
  docs: string
  platforms: IntegrationPlatform[]
  transport: 'stdio' | 'http'
  auth: 'none' | 'secret' | 'oauth'
  cost: string
  runtime?: 'npm' | 'uv'
  package?: string
  packageVersion?: string
  binary?: string
  python?: string
  args: string[]
  env?: Record<string, string>
  url?: string
  fields: IntegrationField[]
  prerequisites: string[]
  skills: string[]
  notes?: string
}
export interface SkillCatalogEntry {
  id: string
  title: string
  category: string
  description: string
  triggers: string[]
  tools: string[]
  steps: string[]
  output: string
  testTask: string
}
export interface WorkflowBundle {
  id: string
  version: string
  title: string
  description: string
  required: string[]
  optional: string[]
  skills: string[]
  roles: string[]
  example: string
}
export type SetupPhase = 'checking' | 'installing' | 'configuring' | 'authentication' | 'testing' | 'approval' | 'ready' | 'failed' | 'cancelled'
export interface SetupJob {
  id: string
  presetId: string
  phase: SetupPhase
  serverId: string | null
  message: string
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface PrerequisiteCheck {
  id: string
  label: string
  available: boolean
  path?: string
  installable: boolean
  instruction: string
}
export interface SetupCheck {
  supported: boolean
  platform: IntegrationPlatform
  checks: PrerequisiteCheck[]
  valid: boolean
}
export interface SetupTool {
  name: string
  description: string
  group: GrantGroup
  policy: 'allow' | 'confirm' | 'off'
}
export interface SetupJobDetails extends SetupJob {
  values?: Record<string, string>
  tools: SetupTool[]
  roles: string[]
  authorizationUrl?: string
}
export interface IntegrationCatalog {
  version: string
  platform: IntegrationPlatform
  presets: Array<McpPreset & { serverId?: string; status?: string }>
  skills: Array<SkillCatalogEntry & { enabled: boolean }>
  bundles: Array<WorkflowBundle & { active: boolean; selectedOptional: string[] }>
  jobs: SetupJob[]
}
