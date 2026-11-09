export type User = {
  id: string;
  name: string;
  username: string;
  admin: boolean;
};
export type Clip = {
  id: string;
  assetId: string;
  in: number;
  out: number;
  volume: number;
  muted: boolean;
  title: string;
  titleSize: number;
  titlePosition: "center" | "bottom";
  transition: "cut" | "fade";
};
export type Document = {
  format: "landscape" | "portrait" | "square";
  clips: Clip[];
  musicId: string | null;
  musicVolume: number;
};
export type Asset = {
  id: string;
  name: string;
  kind: "video" | "audio";
  state: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  bytes: number;
  error: string;
  proxy: string | null;
  poster: string | null;
  wave: string | null;
};
export type Job = {
  assetId: string | null;
  id: string;
  kind: string;
  state: string;
  progress: number;
  stage: string;
  error: string;
  attempt: number;
  created: number;
  download: string | null;
};
export type Project = {
  id: string;
  name: string;
  revision: number;
  updated: number;
  document: Document;
};
export type Bundle = {
  project: Project;
  role: string;
  assets: Asset[];
  jobs: Job[];
  comments: {
    id: string;
    author: string;
    text: string;
    at: number;
    created: number;
  }[];
  versions: { revision: number; name: string; created: number }[];
};
export type ProjectCard = {
  id: string;
  name: string;
  revision: number;
  updated: number;
  clips: number;
  duration: number;
  format: string;
  poster: string | null;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r
      .json()
      .catch(() => ({ error: "Bağlantı kurulamadı." }));
    throw new ApiError(r.status, data.error || "İşlem başarısız.");
  }
  return r.status === 204 ? (undefined as T) : r.json();
}
export const duration = (d: Document) =>
  d.clips.reduce((n, c) => n + c.out - c.in, 0);
export function locate(d: Document, time: number) {
  let start = 0;
  for (let i = 0; i < d.clips.length; i++) {
    const c = d.clips[i],
      end = start + c.out - c.in;
    if (time < end || i === d.clips.length - 1)
      return {
        clip: c,
        index: i,
        start,
        local: Math.max(0, Math.min(time - start, c.out - c.in - 0.001)),
      };
    start = end;
  }
  return null;
}
export const clock = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, s) % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((Math.max(0, s) % 1) * 30)
    .toString()
    .padStart(2, "0")}`;
export const size = (n: number) =>
  n < 1048576
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
export const date = (ticks: number) =>
  new Date((ticks - 621355968000000000) / 10000).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
export const emptyDoc = (): Document => ({
  format: "landscape",
  clips: [],
  musicId: null,
  musicVolume: 0.2,
});
