/**
 * Question cache — offline-friendly passthrough store for Question JSON,
 * keyed by question id in the STORAGE.questions collection. Eviction (if ever
 * needed) can enumerate ids via StoragePort.keys().
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { Question } from '../model/question.js';

export class QuestionCache {
  constructor(private readonly storage: StoragePort) {}

  async get(id: string): Promise<Question | undefined> {
    return this.storage.get<Question>(STORAGE.questions, id);
  }

  async put(question: Question): Promise<void> {
    await this.storage.set(STORAGE.questions, question.id, question);
  }

  async putMany(questions: Question[]): Promise<void> {
    for (const q of questions) await this.put(q);
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }
}
