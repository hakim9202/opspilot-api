/** Lab plan catalog — no real money / Stripe. */
export type LabPlanId = 'free' | 'team' | 'enterprise';

export type LabPlan = {
  id: LabPlanId;
  label: string;
  maxClusters: number; // -1 = unlimited
  description: string;
};

export const LAB_PLANS: Record<LabPlanId, LabPlan> = {
  free: {
    id: 'free',
    label: 'Free',
    maxClusters: 1,
    description: '1 cluster — lab / trial',
  },
  team: {
    id: 'team',
    label: 'Team',
    maxClusters: 5,
    description: 'Up to 5 clusters',
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    maxClusters: -1,
    description: 'Unlimited clusters (lab)',
  },
};

export function resolvePlan(plan: string): LabPlan {
  const id = (plan || 'free') as LabPlanId;
  return LAB_PLANS[id] || LAB_PLANS.free;
}

export function clustersAllowed(maxClusters: number, used: number): boolean {
  if (maxClusters < 0) return true;
  return used < maxClusters;
}
