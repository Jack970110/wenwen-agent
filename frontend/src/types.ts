export type Role = 'user' | 'assistant';

export interface UIMessage {
  id: string;
  role: Role;
  parts: { type: string; text: string }[];
}

export interface ChatEvent {
  type: 'tool-call' | 'tool-error' | 'text-delta' | 'done' | 'error';
  toolName?: string;
  args?: unknown;
  text?: string;
  message?: string;
}
