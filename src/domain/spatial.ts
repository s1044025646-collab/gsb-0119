import { DieGeom } from "./geometry";

export type PatternKind = "edge_ring" | "scratch" | "cluster" | "random";

export interface SpatialThresholds {
  edgeRingBandMm: number;   // 距有效边缘多近算边缘环
  edgeRingRatio: number;    // 边缘带内失效占比超过该值判为边缘环
  scratchMaxWidthMm: number;// 划痕线拟合最大带宽
  scratchMinCount: number;  // 线上最少失效数
  clusterRadiusMm: number;  // 局部聚集半径
  clusterMinCount: number;  // 聚集最少失效数
}

export const DEFAULT_THRESHOLDS: SpatialThresholds = {
  edgeRingBandMm: 10,
  edgeRingRatio: 0.6,
  scratchMaxWidthMm: 4,
  scratchMinCount: 6,
  clusterRadiusMm: 15,
  clusterMinCount: 5,
};

export interface FailPoint { x: number; y: number; cx: number; cy: number; r: number; }

export interface Classification {
  pattern: PatternKind;
  confidence: number;
  evidence: Record<string, number | string>;
  assigned: Record<number, PatternKind>; // fail 索引 -> 类别
}

// 误判依据全部写入 evidence，供人工审核
export function classifyFails(
  fails: FailPoint[],
  effRadiusMm: number,
  th: SpatialThresholds = DEFAULT_THRESHOLDS,
): Classification {
  const assigned: Record<number, PatternKind> = {};
  const evidence: Record<string, number | string> = { failCount: fails.length };
  if (fails.length === 0) {
    return { pattern: "random", confidence: 1, evidence, assigned };
  }

  // 1) 边缘环：失效集中在有效半径外侧环带
  const ringIdx = fails.map((f, i) => ({ f, i })).filter(({ f }) => f.r >= effRadiusMm - th.edgeRingBandMm);
  const ringRatio = ringIdx.length / fails.length;
  evidence.ringRatio = Number(ringRatio.toFixed(3));
  if (ringRatio >= th.edgeRingRatio && ringIdx.length >= 3) {
    ringIdx.forEach(({ i }) => (assigned[i] = "edge_ring"));
    evidence.rule = "ringRatio>=edgeRingRatio";
    return { pattern: "edge_ring", confidence: ringRatio, evidence, assigned };
  }

  // 2) 划痕：存在一条窄带覆盖足够多失效点（暴力搜索角度）
  let bestLine: { count: number; idx: number[]; span: number } = { count: 0, idx: [], span: 0 };
  for (let deg = 0; deg < 180; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const nx = -Math.sin(a), ny = Math.cos(a);
    const dx = Math.cos(a), dy = Math.sin(a);
    const dists = fails.map((f, i) => ({ d: Math.abs(f.cx * nx + f.cy * ny), i }));
    dists.sort((p, q) => p.d - q.d);
    const idx: number[] = [];
    for (const { d, i } of dists) {
      if (d <= th.scratchMaxWidthMm / 2) idx.push(i);
    }
    // 划痕须沿线有足够跨度，避免把致密点团误判为线
    let span = 0;
    if (idx.length >= 2) {
      const projs = idx.map((i) => fails[i].cx * dx + fails[i].cy * dy);
      span = Math.max(...projs) - Math.min(...projs);
    }
    if (idx.length > bestLine.count && span >= 30) bestLine = { count: idx.length, idx, span };
  }
  evidence.scratchLineCount = bestLine.count;
  if (bestLine.count >= th.scratchMinCount) {
    bestLine.idx.forEach((i) => (assigned[i] = "scratch"));
    evidence.rule = "scratchLineCount>=scratchMinCount";
    return { pattern: "scratch", confidence: bestLine.count / fails.length, evidence, assigned };
  }

  // 3) 局部聚集：某半径邻域内失效密度显著
  let bestCluster: { count: number; idx: number[] } = { count: 0, idx: [] };
  for (let i = 0; i < fails.length; i++) {
    const idx: number[] = [];
    for (let j = 0; j < fails.length; j++) {
      const d = Math.hypot(fails[i].cx - fails[j].cx, fails[i].cy - fails[j].cy);
      if (d <= th.clusterRadiusMm) idx.push(j);
    }
    if (idx.length > bestCluster.count) bestCluster = { count: idx.length, idx };
  }
  evidence.clusterMaxCount = bestCluster.count;
  if (bestCluster.count >= th.clusterMinCount) {
    bestCluster.idx.forEach((i) => (assigned[i] = "cluster"));
    evidence.rule = "clusterMaxCount>=clusterMinCount";
    return { pattern: "cluster", confidence: bestCluster.count / fails.length, evidence, assigned };
  }

  // 4) 随机
  evidence.rule = "no spatial signature above thresholds";
  fails.forEach((_, i) => (assigned[i] = "random"));
  return { pattern: "random", confidence: 1, evidence, assigned };
}
