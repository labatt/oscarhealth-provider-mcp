import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Plan {
  label: string;
  year: number;
  state: string;
  networkId: string;
  policyId: string;
  zipCode: string;
  formularyPlanType: string;
}

export interface PlanBook {
  defaultPlan: string;
  plans: Record<string, Plan>;
}

/** `<project root>/config/plans.json`, whether running from `src/` or `dist/`. */
const DEFAULT_PATH = fileURLToPath(new URL('../config/plans.json', import.meta.url));

export function loadPlans(path: string = DEFAULT_PATH): PlanBook {
  const book = JSON.parse(readFileSync(path, 'utf8')) as PlanBook;
  if (!book.plans?.[book.defaultPlan]) {
    throw new Error(`plans.json: defaultPlan "${book.defaultPlan}" is not present in plans.`);
  }
  return book;
}

/**
 * The error lists the valid ids because this surfaces through an MCP tool to a
 * model, which can correct itself from the list but not from "not found".
 */
export function resolvePlan(book: PlanBook, id?: string): Plan {
  const key = id ?? book.defaultPlan;
  const plan = book.plans[key];
  if (!plan) {
    throw new Error(`Unknown plan "${key}". Available: ${Object.keys(book.plans).join(', ')}`);
  }
  return plan;
}
