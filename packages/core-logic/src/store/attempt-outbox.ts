import type { AttemptRecord } from '../api/types.js';
import { STORAGE, type StoragePort } from '../ports/index.js';

export type QueuedAttempt = AttemptRecord & { clientAttemptId: string };

interface PendingAttempt {
  userId: string;
  attempt: QueuedAttempt;
}

const OUTBOX_KEY = 'attempt-outbox';

/**
 * Durable per-account audit outbox. A response can be lost after the server
 * commits, so the stable clientAttemptId is retained until an acknowledged
 * retry; the server's unique key makes that retry harmless.
 */
export class AttemptOutbox {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StoragePort) {}

  private async read(): Promise<PendingAttempt[]> {
    return (await this.storage.get<PendingAttempt[]>(STORAGE.history, OUTBOX_KEY)) ?? [];
  }

  private mutate(change: (entries: PendingAttempt[]) => void): Promise<void> {
    const run = this.mutationTail.then(async () => {
      const entries = await this.read();
      change(entries);
      await this.storage.set(STORAGE.history, OUTBOX_KEY, entries);
    });
    this.mutationTail = run.catch(() => undefined);
    return run;
  }

  enqueue(userId: string, attempt: QueuedAttempt): Promise<void> {
    return this.mutate((entries) => {
      if (
        entries.some(
          (entry) =>
            entry.userId === userId &&
            entry.attempt.clientAttemptId === attempt.clientAttemptId,
        )
      ) {
        return;
      }
      entries.push({ userId, attempt });
    });
  }

  async list(userId: string, limit = 1000): Promise<QueuedAttempt[]> {
    await this.mutationTail;
    return (await this.read())
      .filter((entry) => entry.userId === userId)
      .slice(0, limit)
      .map((entry) => entry.attempt);
  }

  remove(userId: string, clientAttemptIds: string[]): Promise<void> {
    const ids = new Set(clientAttemptIds);
    return this.mutate((entries) => {
      const kept = entries.filter(
        (entry) =>
          entry.userId !== userId || !ids.has(entry.attempt.clientAttemptId),
      );
      entries.splice(0, entries.length, ...kept);
    });
  }

  async count(userId: string): Promise<number> {
    await this.mutationTail;
    return (await this.read()).filter((entry) => entry.userId === userId).length;
  }
}
