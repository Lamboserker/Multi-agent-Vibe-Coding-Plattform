import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service.js'

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async grantCredits(userId: string, amount: number, reason: string, provider = 'manual') {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.paymentAccount.upsert({
        where: { userId },
        create: { userId, creditBalance: new Prisma.Decimal(amount), plan: 'free' },
        update: { creditBalance: { increment: new Prisma.Decimal(amount) } },
      })
      const ledger = await tx.creditLedger.create({
        data: {
          userId,
          amount: new Prisma.Decimal(amount),
          reason,
          provider,
        },
      })
      return { account, ledger }
    })
  }

  async reserveForTask(userId: string, taskId: string, amount: number, provider: string) {
    return this.prisma.creditLedger.create({
      data: {
        userId,
        taskId,
        amount: new Prisma.Decimal(-Math.abs(amount)),
        reason: 'agent_run_estimated_reservation',
        provider,
      },
    })
  }
}
