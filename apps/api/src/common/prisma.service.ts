import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
    // busy_timeout is per connection: without it a concurrent writer fails immediately with SQLITE_BUSY.
    // WAL + synchronous=NORMAL keeps commits durable across app crashes while avoiding an fsync per write.
    await this.$queryRawUnsafe('PRAGMA busy_timeout=5000;')
    await this.$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    await this.$queryRawUnsafe('PRAGMA synchronous=NORMAL;')
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
