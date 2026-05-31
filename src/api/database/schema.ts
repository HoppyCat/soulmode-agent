export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type AgentFileKey =
  | "PRISM"
  | "OPS"
  | "STYLE"
  | "KNOW"
  | "HEURISTICS"
  | "INDEX"
  | "MEMORY"
  | "WORKING_MEMORY"
  | "HUMAN"
  | "CHANGELOG";

export type LibrarySource = {
  key: string;
  title: string;
  category: string;
  url: string;
  description: string;
  enabled: number;
};

