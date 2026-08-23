import { auditEvents } from "@math/db";
import type { ContentTransaction } from "../content/repository.js";

export interface AuditEventRecord {
  actorUserId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
}

export class AuditRepository {
  async append(transaction: ContentTransaction, event: AuditEventRecord): Promise<void> {
    await transaction.insert(auditEvents).values(event);
  }
}
