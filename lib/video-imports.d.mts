export type VideoPublication = {
  status: 'uploading' | 'uploaded' | 'failed'; progress: number;
  kind?: 'public' | 'private'; assetId?: string;
  url?: string; objectKey?: string; uploadedAt?: number; error?: string;
};
export type VideoJob = {
  id: string; title: string; sourceHost: string;
  status: 'queued' | 'checking' | 'downloading' | 'muxing' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  createdAt: number; finishedAt?: number; downloaded: number; total: number; bytes: number;
  error: string; notice?: string; duration?: number; fileBytes?: number; savedPath?: string;
  publication?: VideoPublication;
  tailRecovery?: { missingSeconds: number; originalDuration: number; keptDuration: number; downloaded: number; total: number; retainedAt: number };
  incomplete?: { missingSegments: number; missingSeconds: number; originalDuration: number };
};
type VideoInput = { title: string; url: string; backupUrl?: string; sourceHost: string };
export function toolsStatus(): Promise<{ ready: boolean; message: string }>;
export function createPairing(): { token: string; expiresAt: number };
export function validPairing(token: string): boolean;
export function consumePairing(token: string): void;
export function validateBatch(input: unknown): VideoInput[];
export function listVideoJobs(): VideoJob[];
export function getVideoJob(id: string): VideoJob | null;
export function setVideoPublication(id: string, publication: VideoPublication): VideoJob;
export function videoFile(id: string): string | null;
export function videoRoot(): string;
export function createVideoJobs(videos: VideoInput[]): Promise<VideoJob[]>;
export function cancelVideoJob(id: string): VideoJob | null;
export function confirmVideoTail(id: string): VideoJob;
export function discardVideoTail(id: string): Promise<VideoJob>;
