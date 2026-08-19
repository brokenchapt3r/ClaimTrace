export type ClaimStatus =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'CONFLICTED'
  | 'ABSTAINED'
  | 'NO_PERMISSION';

export type RelationType = 'support' | 'conflict' | 'unknown';

export type ClaimComponent = {
  id: string;
  text: string;
};

export type ClaimDependency = {
  from: string;
  to: string;
  type: 'premise' | 'implication' | 'exclusion';
  confidence: number;
};

export type Claim = {
  id: string;
  title: string;
  atom: string;
  subject: string;
  predicate: string;
  object: string;
  condition: string;
  time: string;
  components: ClaimComponent[];
  missingComponents: string[];
  x: number;
  y: number;
};

export type RetrievalMetrics = {
  semantic: number;
  bm25: number;
  bm25Normalized: number;
  freshness: number;
  titleCoverage: number;
  combined: number;
};

export type EvidenceRelation = {
  id: string;
  claimId: string;
  evidenceId: string;
  type: RelationType;
  supportProbability: number;
  conflictProbability: number;
  unknownProbability: number;
  threshold: number;
  coveredComponentIds: string[];
  active: boolean;
  selected: boolean;
  cutReason?: 'permission' | 'superseded' | 'optimizer';
  reason: string;
};

export type Evidence = {
  id: string;
  title: string;
  source: string;
  text: string;
  x: number;
  y: number;
  score?: number;
  docId?: string;
  kbId?: string;
  chunkId?: string;
  imageId?: string;
  pageNumbers?: number[];
  position?: number[][];
  createdAt?: string;
  effectiveAt?: string;
  version?: string;
  clauseKey?: string;
  canonicalSourceId?: string;
  hierarchicalTitles: string[];
  permissionLabel?: string;
  admissionScopes: string[];
  requiredScopes: string[];
  accessAllowed: boolean;
  metrics: RetrievalMetrics;
  relations: EvidenceRelation[];
};

export type AccessContext = {
  userId: string;
  scopes: string[];
  sensitivity: 'normal' | 'high';
};

export type PropagationSnapshot = {
  id: string;
  label: string;
  state: string;
  note: string;
  claimStatus: Record<string, ClaimStatus>;
  evidenceStatus: Record<string, ClaimStatus>;
  activeEdgeIds: string[];
  changedClaimIds: string[];
  changedEdgeIds: string[];
};

export type OptimizationResult = {
  claimStatus: Record<string, ClaimStatus>;
  selectedEdgeIds: string[];
  objective: number;
  elapsedMs: number;
  fallback: boolean;
};

export type PipelineResult = {
  draft: string;
  claims: Claim[];
  evidence: Evidence[];
  dependencies: ClaimDependency[];
  snapshots: PropagationSnapshot[];
  optimization: OptimizationResult;
  answer: string;
  explanations: Record<string, string>;
};
