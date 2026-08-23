import type { ContentTransaction as DatabaseTransaction } from "../content/repository.js";
import type { AuditEventRecord, AuditRepository } from "./repository.js";

export interface AuditEventInput extends AuditEventRecord {}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  record(transaction: DatabaseTransaction, event: AuditEventInput): Promise<void> {
    return this.repository.append(transaction, event);
  }
}
