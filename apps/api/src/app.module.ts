import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { AuthMiddleware } from './auth/auth.middleware.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService } from './auth/auth.service.js'
import { CostsController } from './costs/costs.controller.js'
import { CostsService } from './costs/costs.service.js'
import { PrismaService } from './common/prisma.service.js'
import { ContextBuilderService } from './orchestrator/context-builder.service.js'
import { CostRouterService } from './orchestrator/cost-router.service.js'
import { RepoScannerService } from './orchestrator/repo-scanner.service.js'
import { TaskAnalyzerService } from './orchestrator/task-analyzer.service.js'
import { ProjectsController } from './projects/projects.controller.js'
import { ProjectsService } from './projects/projects.service.js'
import { ModelsController } from './models/models.controller.js'
import { ModelsService } from './models/models.service.js'
import { ProvidersController } from './providers/providers.controller.js'
import { ProvidersService } from './providers/providers.service.js'
import { TasksController } from './tasks/tasks.controller.js'
import { TasksService } from './tasks/tasks.service.js'
import { WorkspaceController } from './workspace/workspace.controller.js'
import { RunsController } from './runs/runs.controller.js'
import { RunsService } from './runs/runs.service.js'
import { SubtasksController } from './subtasks/subtasks.controller.js'
import { SubtasksService } from './subtasks/subtasks.service.js'
import { ValidationController } from './validation/validation.controller.js'
import { ValidationService } from './validation/validation.service.js'
import { WorkspaceOrchestratorService } from './orchestrator/workspace-orchestrator.service.js'
import { PaymentService } from './payments/payment.service.js'
import { EventBusService } from './runtime/event-bus.service.js'
import { JobQueueService } from './runtime/job-queue.service.js'
import { SettingsService } from './runtime/settings.service.js'
import { SystemController } from './runtime/system.controller.js'
import { OrchestratorService } from './orchestration/orchestrator.service.js'
import { OrchestratorController } from './orchestration/orchestrator.controller.js'
import { LocalModelsService } from './local-models/local-models.service.js'
import { LocalModelsController } from './local-models/local-models.controller.js'
import { ExecutionService } from './execution/execution.service.js'
import { ExecutionController } from './execution/execution.controller.js'
import { RepoContextService } from './execution/repo-context.service.js'
import { PlanInsightsService } from './execution/plan-insights.service.js'
import { PlanInsightsController } from './execution/plan-insights.controller.js'
import { ResourceMonitorService } from './local-models/resource-monitor.service.js'
import { WorkspaceFsService } from './workspace-fs/workspace-fs.service.js'
import { WorkspaceFsController } from './workspace-fs/workspace-fs.controller.js'
import { SelfTestController } from './runtime/self-test.controller.js'
import { SessionsService } from './sessions/sessions.service.js'
import { DiagnosticsService } from './runtime/diagnostics.service.js'
import { SessionsController } from './sessions/sessions.controller.js'
import { PluginsService } from './plugins/plugins.service.js'
import { PluginsController } from './plugins/plugins.controller.js'
import { SkillsService } from './skills/skills.service.js'
import { SkillsController } from './skills/skills.controller.js'
import { McpService } from './mcp/mcp.service.js'
import { McpController } from './mcp/mcp.controller.js'
import { AgentResourcesService } from './agents/agent-resources.service.js'
import { IdeService } from './ide/ide.service.js'
import { AgentProfilesService } from './agents/agent-profiles.service.js'
import { AgentsController } from './agents/agents.controller.js'
import { IdeController } from './ide/ide.controller.js'
import { LocalHistoryService } from './ide/local-history.service.js'
import { DesignService } from './design/design.service.js'
import { DesignController } from './design/design.controller.js'
import { IntegrationsService } from './integrations/integrations.service.js'
import { IntegrationsController } from './integrations/integrations.controller.js'

@Module({
  controllers: [
    AuthController,
    ProjectsController,
    TasksController,
    ModelsController,
    CostsController,
    ProvidersController,
    ValidationController,
    RunsController,
    SubtasksController,
    WorkspaceController,
    SystemController,
    OrchestratorController,
    LocalModelsController,
    ExecutionController,
    PlanInsightsController,
    WorkspaceFsController,
    SelfTestController,
    SessionsController,
    PluginsController,
    SkillsController,
    McpController,
    IdeController,
    AgentsController,
    DesignController,
    IntegrationsController,
  ],
  providers: [
    PrismaService,
    AuthService,
    ProjectsService,
    TasksService,
    RunsService,
    SubtasksService,
    ModelsService,
    CostsService,
    ProvidersService,
    ValidationService,
    RepoScannerService,
    ContextBuilderService,
    TaskAnalyzerService,
    CostRouterService,
    WorkspaceOrchestratorService,
    PaymentService,
    EventBusService,
    JobQueueService,
    SettingsService,
    OrchestratorService,
    LocalModelsService,
    ExecutionService,
    PlanInsightsService,
    ResourceMonitorService,
    RepoContextService,
    WorkspaceFsService,
    SessionsService,
    DiagnosticsService,
    PluginsService,
    SkillsService,
    McpService,
    AgentResourcesService,
    IdeService,
    AgentProfilesService,
    LocalHistoryService,
    DesignService,
    IntegrationsService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .exclude(
        { path: 'auth/login', method: RequestMethod.POST },
        { path: 'auth/register', method: RequestMethod.POST },
        { path: 'auth/logout', method: RequestMethod.POST },
        { path: 'auth/me', method: RequestMethod.GET },
        { path: '*', method: RequestMethod.OPTIONS },
      )
      .forRoutes('*')
  }
}
