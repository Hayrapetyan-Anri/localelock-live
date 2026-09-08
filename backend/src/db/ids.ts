import { randomBytes } from 'node:crypto';

function token(bytes = 6): string {
  return randomBytes(bytes).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, bytes * 2).toLowerCase();
}

function stamp(): string {
  return Date.now().toString(36);
}

export const newRunId = (): string => `run_${stamp()}_${token(4)}`;
export const newFindingId = (): string => `f_${stamp()}_${token(4)}`;
export const newApprovalId = (): string => `appr_${stamp()}_${token(4)}`;
export const newApprovalBatchId = (): string => `apprb_${stamp()}_${token(4)}`;
export const newEventId = (): string => `evt_${stamp()}_${token(4)}`;

export const seededEventId = (key: string): string => `evt_${key}`;
export const seededFindingId = (key: string): string => `f_${key}`;
export const seededRunId = (key: string): string => `run_${key}`;
