import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common'
import { str } from '../common/validate.js'
import { ProjectsService } from './projects.service.js'

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@Body() body: { name: string; repoPath: string; defaultBranch?: string }) {
    return this.projects.create(body)
  }

  @Post('link')
  link(@Body() body: { name: string; repoPath: string; defaultBranch?: string }) {
    return this.projects.link(body)
  }

  /** Open an existing folder/repository from the local file system. */
  @Post('open')
  open(@Body() body: unknown) {
    return this.projects.open(str(body, 'path', { max: 1000 }), str(body, 'name', { optional: true, max: 200 }) || undefined)
  }

  /** Create a new empty project (folder + git init + initial commit). */
  @Post('new')
  createNew(@Body() body: unknown) {
    return this.projects.createNew(str(body, 'parentDir', { max: 1000 }), str(body, 'name', { max: 80 }))
  }

  @Post('clone')
  clone(@Body() body: unknown) {
    return this.projects.clone(str(body, 'url', { max: 1000 }), str(body, 'parentDir', { max: 1000 }), str(body, 'name', { optional: true, max: 100 }) || undefined)
  }

  @Get()
  findAll() {
    return this.projects.findAll()
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projects.findOne(id)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.projects.remove(id)
  }

  @Post(':id/index')
  index(@Param('id') id: string) {
    return this.projects.index(id)
  }
}
