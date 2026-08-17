import { z } from "zod";

export const RoleSchema = z.enum(["student", "guardian", "teacher", "operator"]);

export type Role = z.infer<typeof RoleSchema>;

export interface Actor {
  userId: string;
  roles: readonly Role[];
}
