import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { bool, num, str, strList } from '../common/validate.js'
import { IdeService, type SearchOptions } from './ide.service.js'

function searchOptions(body: unknown): SearchOptions {
  return {
    query: str(body, 'query', { max: 1000 }),
    regex: bool(body, 'regex'),
    caseSensitive: bool(body, 'caseSensitive'),
    wholeWord: bool(body, 'wholeWord'),
    include: str(body, 'include', { optional: true, max: 1000 }) || undefined,
    exclude: str(body, 'exclude', { optional: true, max: 1000 }) || undefined,
    maxResults: num(body, 'maxResults', { optional: true, min: 1, max: 10_000 }),
  }
}

function position(body: unknown) {
  return { line: num(body, 'line', { min: 1, max: 10_000_000 })!, column: num(body, 'column', { min: 1, max: 1_000_000 })! }
}

/** Optional unsaved editor content of the file the request is about. */
function content(body: unknown) {
  const value = (body as { content?: unknown } | undefined)?.content
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > 6_000_000) throw new BadRequestException('"content" must be a string.')
  return value
}

@Controller('projects/:id/ide')
export class IdeController {
  constructor(private readonly ide: IdeService) {}

  @Get('files')
  files(@Param('id') id: string) {
    return this.ide.fileList(id)
  }

  @Get('context')
  context(@Param('id') id: string, @Query('path') relative = '') { return this.ide.folderContext(id, relative) }

  @Post('search')
  search(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.search(id, searchOptions(body))
  }

  @Post('replace')
  replace(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.replace(id, { ...searchOptions(body), replacement: str(body, 'replacement', { optional: true, max: 100_000 }), files: strList(body, 'files', 5000) })
  }

  @Post('ts/definition')
  definition(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.definition(id, str(body, 'path', { max: 1000 }), position(body), content(body))
  }

  @Post('ts/references')
  references(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.references(id, str(body, 'path', { max: 1000 }), position(body), content(body))
  }

  @Post('ts/rename')
  rename(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.rename(id, str(body, 'path', { max: 1000 }), position(body), str(body, 'newName', { max: 200 }), content(body))
  }

  @Post('ts/hover')
  hover(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.hover(id, str(body, 'path', { max: 1000 }), position(body), content(body))
  }

  @Post('ts/diagnostics')
  diagnostics(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.fileDiagnostics(id, str(body, 'path', { max: 1000 }), content(body))
  }

  @Get('problems')
  problems(@Param('id') id: string) {
    return this.ide.lastCheck(id)
  }

  @Post('problems/check')
  check(@Param('id') id: string) {
    return this.ide.check(id)
  }

  @Post('format')
  format(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.format(id, str(body, 'path', { max: 1000 }), str(body, 'content', { optional: true, max: 6_000_000 }))
  }

  @Get('history')
  history(@Param('id') id: string, @Query('path') file = '') {
    return this.ide.historyList(id, file)
  }

  @Get('history/entry')
  historyEntry(@Param('id') id: string, @Query('path') file = '', @Query('entry') entry = '') {
    return this.ide.historyEntry(id, file, entry)
  }

  @Post('ai/edit')
  aiEdit(@Param('id') id: string, @Body() body: unknown) {
    return this.ide.aiEdit(id, {
      path: str(body, 'path', { max: 1000 }),
      language: str(body, 'language', { optional: true, max: 40 }) || undefined,
      before: str(body, 'before', { optional: true, max: 200_000 }),
      selection: str(body, 'selection', { max: 100_000 }),
      after: str(body, 'after', { optional: true, max: 200_000 }),
      instruction: str(body, 'instruction', { max: 2000 }),
    })
  }
}
