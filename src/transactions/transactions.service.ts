/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Injectable } from '@nestjs/common';
import { Block, Prisma } from '@prisma/client';
import { classToPlain } from 'class-transformer';
import { ApiConfigService } from '../api-config/api-config.service';
import { BlocksTransactionsService } from '../blocks-transactions/blocks-transactions.service';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../common/constants';
import { SortOrder } from '../common/enums/sort-order';
import { standardizeHash } from '../common/utils/hash';
import { PrismaService } from '../prisma/prisma.service';
import { BasePrismaClient } from '../prisma/types/base-prisma-client';
import { FindTransactionOptions } from './interfaces/find-transactions-options';
import { ListTransactionOptions } from './interfaces/list-transactions-options';
import { UpsertTransactionOptions } from './interfaces/upsert-transaction-options';
import { Transaction } from '.prisma/client';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly blocksTransactionsService: BlocksTransactionsService,
    private readonly config: ApiConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async bulkUpsert(
    prisma: BasePrismaClient,
    transactions: UpsertTransactionOptions[],
  ): Promise<Transaction[]> {
    const records = [];
    for (const transaction of transactions) {
      records.push(await this.upsert(prisma, transaction));
    }
    return records;
  }

  private async upsert(
    prisma: BasePrismaClient,
    { hash, fee, size, notes, spends }: UpsertTransactionOptions,
  ): Promise<Transaction> {
    const networkVersion = this.config.get<number>('NETWORK_VERSION');
    hash = standardizeHash(hash);

    return prisma.transaction.upsert({
      create: {
        hash,
        network_version: networkVersion,
        fee,
        size,
        notes: classToPlain(notes),
        spends: classToPlain(spends),
      },
      update: {
        fee,
        size,
        notes: classToPlain(notes),
        spends: classToPlain(spends),
      },
      where: {
        uq_transactions_on_hash_and_network_version: {
          hash,
          network_version: networkVersion,
        },
      },
    });
  }

  async find(
    options: FindTransactionOptions,
  ): Promise<Transaction | (Transaction & { blocks: Block[] }) | null> {
    const networkVersion = this.config.get<number>('NETWORK_VERSION');
    const { withBlocks } = options;

    const where = {
      hash: standardizeHash(options.hash),
      network_version: networkVersion,
    };

    const transaction = await this.prisma.transaction.findFirst({
      where,
    });

    if (transaction !== null && withBlocks) {
      const blocks =
        await this.blocksTransactionsService.findBlocksByTransaction(
          transaction,
        );
      return { ...transaction, blocks };
    }

    return transaction;
  }

  async list(
    options: ListTransactionOptions,
  ): Promise<Transaction[] | (Transaction & { blocks: Block[] })[]> {
    const networkVersion = this.config.get<number>('NETWORK_VERSION');
    const orderBy = { id: SortOrder.DESC };
    const direction = options.before !== undefined ? -1 : 1;
    const limit =
      direction * Math.min(MAX_LIMIT, options.limit || DEFAULT_LIMIT);
    const withBlocks = options.withBlocks ?? false;

    if (options.search !== undefined) {
      const where = {
        hash: standardizeHash(options.search),
        network_version: networkVersion,
      };
      return this.getTransactionsData(orderBy, limit, where, withBlocks);
    } else if (options.blockId !== undefined) {
      const blocksTransactions = await this.blocksTransactionsService.list({
        blockId: options.blockId,
      });
      const transactionsIds = blocksTransactions.map(
        (blockTransaction) => blockTransaction.transaction_id,
      );
      const where = {
        id: { in: transactionsIds },
        network_version: networkVersion,
      };
      return this.getTransactionsData(orderBy, limit, where, withBlocks);
    } else {
      return this.getTransactionsData(orderBy, limit, {}, withBlocks);
    }
  }

  private async getTransactionsData(
    orderBy: { id: SortOrder },
    limit: number,
    where: Prisma.TransactionWhereInput,
    includeBlocks: boolean,
  ): Promise<Transaction[] | (Transaction & { blocks: Block[] })[]> {
    const transactions = await this.prisma.transaction.findMany({
      orderBy,
      take: limit,
      where,
    });

    if (includeBlocks) {
      const transactionsWithBlocks = [];
      for (const transaction of transactions) {
        const blocks =
          await this.blocksTransactionsService.findBlocksByTransaction(
            transaction,
          );
        transactionsWithBlocks.push({
          ...transaction,
          blocks,
        });
      }
      return transactionsWithBlocks;
    }

    return transactions;
  }
}
