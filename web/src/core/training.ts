export type JointLoss = {
  edge: number;
  claim: number;
  state: number;
  rank: number;
};

export const JOINT_LOSS_WEIGHTS = {
  edge: 1,
  claim: 0.8,
  state: 0.5,
  rank: 0.3,
} as const;

// Keeping the loss composition in one function ensures training jobs and evaluation reports use
// the same weighting contract even when individual task heads evolve independently.
export function totalJointLoss(loss: JointLoss) {
  return (
    JOINT_LOSS_WEIGHTS.edge * loss.edge +
    JOINT_LOSS_WEIGHTS.claim * loss.claim +
    JOINT_LOSS_WEIGHTS.state * loss.state +
    JOINT_LOSS_WEIGHTS.rank * loss.rank
  );
}
