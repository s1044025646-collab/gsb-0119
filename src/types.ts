export type DbRecord = Record<string, unknown>;

export type TestKind = "initial" | "retest";

export type AnalysisTrigger =
  | "initial"
  | "retest"
  | "program_change"
  | "wafer_scrap"
  | "batch_split"
  | "manual";

export interface Page {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export interface EffectiveTest {
  dieId: number;
  x: number;
  y: number;
  passed: boolean;
  defectCategory: string | null;
  kind: TestKind;
  attempt: number;
  testedAt: string;
  programId: number;
  programVersion: string;
}

export interface PatternResult {
  type: "edge_ring" | "scratch" | "local_cluster" | "random" | "none";
  detected: boolean;
  threshold: Record<string, number | string>;
  evidence: Record<string, number | string | number[]>;
  falsePositiveBasis: string;
  dieIds: number[];
}

export interface YieldGroup {
  key: string;
  processStep: string;
  equipmentId: number | null;
  equipmentName: string | null;
  chamberId: number | null;
  chamberName: string | null;
  productIds: number[];
  waferCount: number;
  dieCount: number;
  passCount: number;
  failCount: number;
  yield: number;
  comparable: boolean;
  restriction?: string | undefined;
  deltaVsBest: number | null;
}

export interface AnalysisResult {
  scope: "wafer" | "batch";
  denominator: {
    validDieCount: number;
    invalidEdgeDieCount: number;
    missingCoordinateCount: number;
    testedUniqueDieCount: number;
    untestedDieCount: number;
    excludedDuplicateTestCount: number;
  };
  programs: string[];
  patterns: PatternResult[];
  yieldGroups: YieldGroup[];
  conclusion: string[];
}

export class ApiError extends Error {
 constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
