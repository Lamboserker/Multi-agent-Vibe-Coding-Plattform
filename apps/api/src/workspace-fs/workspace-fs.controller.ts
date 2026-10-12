import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common'
import { bool, num, oneOf, str, strList } from '../common/validate.js'
import { WorkspaceFsService } from './workspace-fs.service.js'

@Controller('projects/:id')
export class WorkspaceFsController {
  constructor(private readonly files: WorkspaceFsService) {}

  @Get('tree')
  tree(@Param('id') id: string, @Query('dir') dir = '') {
    return this.files.tree(id, dir)
  }

  @Get('file')
  read(@Param('id') id: string, @Query('path') file: string) {
    return this.files.readFile(id, file ?? '')
  }

  @Put('file')
  write(@Param('id') id: string, @Body() body: unknown) {
    return this.files.writeFile(id, str(body, 'path', { max: 1000 }), str(body, 'content', { optional: true, max: 6_000_000 }), num(body, 'expectedMtimeMs', { optional: true }))
  }

  @Post('entries')
  create(@Param('id') id: string, @Body() body: unknown) {
    return this.files.createEntry(id, str(body, 'path', { max: 1000 }), oneOf(body, 'type', ['file', 'directory'] as const))
  }

  @Post('entries/rename')
  rename(@Param('id') id: string, @Body() body: unknown) {
    return this.files.renameEntry(id, str(body, 'from', { max: 1000 }), str(body, 'to', { max: 1000 }))
  }

  @Delete('entries')
  remove(@Param('id') id: string, @Query('path') entry: string, @Query('confirmCount') confirmCount?: string) {
    return this.files.deleteEntry(id, entry ?? '', confirmCount ? Number(confirmCount) : undefined)
  }

  @Get('search')
  search(@Param('id') id: string, @Query('q') q: string, @Query('regex') regex?: string) {
    return this.files.search(id, (q ?? '').slice(0, 500), regex === '1')
  }

  @Post('watch')
  async watch(@Param('id') id: string) {
    await this.files.watchProject(id)
    return { ok: true }
  }

  @Get('git/status')
  gitStatus(@Param('id') id: string) {
    return this.files.gitStatus(id)
  }

  @Get('git/diff')
  gitDiff(@Param('id') id: string, @Query('path') file?: string, @Query('staged') staged?: string) {
    return this.files.gitDiff(id, file || undefined, staged === '1')
  }

  @Get('git/head-file')
  headFile(@Param('id') id: string, @Query('path') file: string) {
    return this.files.fileAtHead(id, file ?? '')
  }

  @Get('git/branches')
  branches(@Param('id') id: string) {
    return this.files.branches(id)
  }

  @Get('git/log')
  log(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.files.log(id, limit ? Number(limit) : 50)
  }

  @Post('git/stage')
  stage(@Param('id') id: string, @Body() body: unknown) {
    return this.files.stage(id, strList(body, 'paths'))
  }

  @Post('git/unstage')
  unstage(@Param('id') id: string, @Body() body: unknown) {
    return this.files.unstage(id, strList(body, 'paths'))
  }

  @Post('git/discard')
  discard(@Param('id') id: string, @Body() body: unknown) {
    return this.files.discard(id, strList(body, 'paths'), bool(body, 'confirm'))
  }

  @Post('git/commit')
  commit(@Param('id') id: string, @Body() body: unknown) {
    return this.files.commit(id, str(body, 'message', { max: 10_000 }))
  }

  @Post('git/checkout')
  checkout(@Param('id') id: string, @Body() body: unknown) {
    return this.files.checkout(id, str(body, 'branch', { max: 200 }), bool(body, 'create'))
  }

  @Post('git/init')
  init(@Param('id') id: string) {
    return this.files.initGit(id)
  }
}
