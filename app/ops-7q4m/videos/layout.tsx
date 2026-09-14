import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: '本地视频保存｜深巷后台',
  description: '管理本地视频导入任务、查看进度和预览。',
  robots: { index: false, follow: false },
};
export default function VideoLayout({ children }: { children: React.ReactNode }) { return children; }
