export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type AgentFileKey =
  | "SOUL"
  | "AGENTS"
  | "STYLE"
  | "KNOW"
  | "HEURISTICS"
  | "INDEX"
  | "MEMORY"
  | "WORKING_MEMORY"
  | "USER"
  | "CHANGELOG";

export type LibrarySource = {
  key: string;
  title: string;
  category: string;
  url: string;
  description: string;
  enabled: number;
};

