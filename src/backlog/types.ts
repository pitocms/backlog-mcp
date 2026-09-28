// Types for the subset of Backlog API v2 responses this server uses.
// Reference: https://developer.nulab.com/docs/backlog/

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
  chartEnabled: boolean;
  subtaskingEnabled: boolean;
  textFormattingRule: string;
  archived: boolean;
}

export interface BacklogUser {
  id: number;
  userId: string | null;
  name: string;
  roleType: number;
  mailAddress: string | null;
}

export interface BacklogIssueType {
  id: number;
  projectId: number;
  name: string;
  color: string;
  displayOrder: number;
}

export interface BacklogPriority {
  id: number;
  name: string;
}

export interface BacklogCategory {
  id: number;
  projectId: number;
  name: string;
  displayOrder: number;
}

export interface BacklogVersion {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  startDate: string | null;
  releaseDueDate: string | null;
  archived: boolean;
}

export interface BacklogStatus {
  id: number;
  projectId: number;
  name: string;
  color: string;
  displayOrder: number;
}

export interface BacklogIssue {
  id: number;
  projectId: number;
  issueKey: string;
  keyId: number;
  summary: string;
  parentIssueId: number | null;
  issueType: BacklogIssueType;
  status: BacklogStatus;
  priority: BacklogPriority;
  assignee: BacklogUser | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: number | null;
  category: BacklogCategory[];
  milestone: BacklogVersion[];
  created: string;
  updated: string | null;
}

export interface BacklogComment {
  id: number;
  content: string | null;
  createdUser: BacklogUser | null;
  created: string;
  updated: string | null;
}

/** Full issue detail as returned by GET /api/v2/issues/:issueIdOrKey. */
export interface BacklogIssueDetail extends BacklogIssue {
  description: string | null;
  resolution: { id: number; name: string } | null;
  actualHours: number | null;
  createdUser: BacklogUser | null;
  updatedUser: BacklogUser | null;
}

/** Input shape for updating an issue: every field optional, only provided ones are sent. */
export interface IssueUpdate {
  summary?: string;
  description?: string;
  statusId?: number;
  issueTypeId?: number;
  priorityId?: number;
  assigneeId?: number;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  categoryIds?: number[];
  milestoneIds?: number[];
}

/** Input shape for creating an issue (validated by Zod at the tool layer). */
export interface ProposedIssue {
  summary: string;
  description?: string;
  issueTypeId: number;
  priorityId: number;
  assigneeId?: number;
  startDate?: string;
  dueDate?: string;
  estimatedHours?: number;
  categoryIds?: number[];
  milestoneIds?: number[];
  parentIssueId?: number;
}
