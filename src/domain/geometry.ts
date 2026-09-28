export interface DieGeom {
  x: number;
  y: number;
  cx: number; // 芯片中心 mm 坐标（圆心为原点）
  cy: number;
  r: number;  // 到圆心距离
  valid: boolean;
}

// 依据晶圆圆形有效区域计算每颗芯片坐标；边缘 exclusion 之外为无效芯片，不计入分母
export function dieGeometry(
  diameterMm: number,
  dieX: number,
  dieY: number,
  edgeExclMm: number,
): DieGeom[] {
  const radius = diameterMm / 2;
  const effR = radius - edgeExclMm;
  const nx = Math.floor(diameterMm / dieX);
  const ny = Math.floor(diameterMm / dieY);
  const out: DieGeom[] = [];
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      const cx = (ix - (nx - 1) / 2) * dieX;
      const cy = (iy - (ny - 1) / 2) * dieY;
      const r = Math.hypot(cx, cy);
      out.push({ x: ix, y: iy, cx, cy, r, valid: r <= effR });
    }
  }
  return out;
}
