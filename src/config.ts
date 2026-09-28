export const config = {
  dbPath: process.env.WAFER_DB ?? "wafer.db",
  port: Number(process.env.PORT ?? 0), // 0 = 自动分配本机空闲端口
};
