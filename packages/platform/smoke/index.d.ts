// Types of @worca/platform/smoke (index.mjs).
export interface SmokeMail { subject: string; text?: string; html?: string; at?: number; id?: string }
export interface Inbox { getMail(to: string): Promise<SmokeMail[]> }
export const SMOKE_ORG: string;
export function devCaptureInbox(appOrigin: string): Inbox;
export function moduleInbox(file: string): Promise<Inbox>;
export interface SmokeOptions {
  appOrigin: string;
  instanceOrigin: (host: string) => string;
  email: string;
  inbox: Inbox;
  setupToken?: string;
  passkeyFile?: string;
  turnstileBypassToken?: string;
  timeoutMs?: number;
  mailTimeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}
export function runSmoke(opts: SmokeOptions): Promise<{ instanceId: string; host: string | null; timings: Record<string, number> }>;
