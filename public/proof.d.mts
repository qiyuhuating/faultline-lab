import type { Experiment, DetailedJob, Verdict } from '../src/domain/types.ts';
export function evaluateExperiment(experiment: Experiment, jobs: DetailedJob[], now?: number): Verdict;
export const SCENARIOS: Record<string, { name: string; question: string }>;
