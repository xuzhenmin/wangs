export type PackagedPrivateVideo = {
  directory: string; key: Buffer; manifest: string; duration: number;
  segments: { name: string; file: string; bytes: number }[];
  cleanup: () => Promise<void>;
};
export function packagePrivateVideo(file: string, options?: {
  signal?: AbortSignal; timeoutMs?: number;
  run?: (command: string, args: string[], signal: AbortSignal) => Promise<string>;
}): Promise<PackagedPrivateVideo>;
