import { randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 5 * 60 * 1000;
export const STREAM_TICKET_SCOPES = [
  'workflow/status',
  'workflow/events',
  'runs/stream',
  'chat/stream',
  'agents/chat/stream',
  'workspace/git-browser',
] as const;
export type StreamTicketScope = typeof STREAM_TICKET_SCOPES[number];
const tickets = new Map<string, { userId: string; scope: StreamTicketScope; expiresAt: number }>();

export function issueStreamTicket(userId: string, scope: StreamTicketScope): { ticket: string; expiresAt: number } {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + TICKET_TTL_MS;
  tickets.set(ticket, { userId, scope, expiresAt });
  return { ticket, expiresAt };
}

export function validateStreamTicket(ticket: string, scope: StreamTicketScope): string | undefined {
  const entry = tickets.get(ticket);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    tickets.delete(ticket);
    return undefined;
  }
  if (entry.scope !== scope) return undefined;
  return entry.userId;
}
