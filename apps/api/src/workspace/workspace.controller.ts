import { Body, Controller, Post } from '@nestjs/common'
import { WorkspaceOrchestratorService } from '../orchestrator/workspace-orchestrator.service.js'

@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceOrchestratorService) {}

  @Post('chat')
  chat(@Body() body: Parameters<WorkspaceOrchestratorService['handleWorkspaceChatMessage']>[0]) {
    return this.workspace.handleWorkspaceChatMessage(body)
  }
}
