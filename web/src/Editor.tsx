import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpRight,
  Clapperboard,
  Clock,
  Copy,
  Film,
  Headphones,
  LoaderCircle,
  MessageSquare,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Settings2,
  Share2,
  SkipBack,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  clock,
  date,
  duration,
  emptyDoc,
  locate,
  size,
  type Asset,
  type Bundle,
  type Clip,
  type Document as EditDoc,
  type Job,
  type User,
} from "./domain";
export function Editor({
  id,
  user,
  onBack,
  onLogout,
}: {
  id: string;
  user: User;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null),
    [doc, setDoc] = useState<EditDoc>(emptyDoc),
    [name, setName] = useState(""),
    [revision, setRevision] = useState(1),
    [status, setStatus] = useState("saved"),
    [error, setError] = useState(""),
    [selection, setSelection] = useState(""),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [zoom, setZoom] = useState(45),
    [mediaTab, setMediaTab] = useState("all"),
    [rightTab, setRightTab] = useState("clip"),
    [showProperties, setShowProperties] = useState(false),
    [exporting, setExporting] = useState(false),
    [preset, setPreset] = useState("1080p"),
    [renderBusy, setRenderBusy] = useState(false),
    [share, setShare] = useState(false),
    [upload, setUpload] = useState<{
      name: string;
      progress: number;
      stage: string;
    } | null>(null),
    [note, setNote] = useState(""),
    [, setHist] = useState(0),
    [ready, setReady] = useState(0),
    [stageHeight, setStageHeight] = useState(360);
  const current = useRef(doc),
    currentName = useRef(name),
    currentRevision = useRef(1),
    initialized = useRef(false),
    dirty = useRef(false),
    conflict = useRef(false),
    saving = useRef<Promise<void> | null>(null),
    playhead = useRef(0),
    video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    stage = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null),
    abortUpload = useRef<AbortController | null>(null),
    history = useRef<{ past: EditDoc[]; future: EditDoc[] }>({
      past: [],
      future: [],
    }),
    keyHandler = useRef<(e: KeyboardEvent) => void>(() => {}),
    trim = useRef<{
      id: string;
      edge: string;
      x: number;
      in: number;
      out: number;
    } | null>(null);
  const writable = bundle?.role === "owner" || bundle?.role === "editor",
    total = duration(doc),
    active = locate(doc, Math.min(time, Math.max(0, total - 0.001))),
    activeAsset = bundle?.assets.find((a) => a.id === active?.clip.assetId),
    selected = doc.clips.find((c) => c.id === selection) || active?.clip,
    selectedAsset = bundle?.assets.find((a) => a.id === selected?.assetId),
    music = bundle?.assets.find((a) => a.id === doc.musicId);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) {
      onLogout();
      return;
    }
    setError((e as Error).message);
  }
  async function load() {
    try {
      const b = await api<Bundle>("/projects/" + id);
      setBundle(b);
      if (
        !initialized.current ||
        (!dirty.current && b.project.revision !== currentRevision.current)
      ) {
        initialized.current = true;
        current.current = b.project.document;
        currentName.current = b.project.name;
        currentRevision.current = b.project.revision;
        setDoc(b.project.document);
        setName(b.project.name);
        setRevision(b.project.revision);
        setSelection(b.project.document.clips[0]?.id || "");
        history.current = { past: [], future: [] };
        setHist((h) => h + 1);
      }
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    load();
    const interval = setInterval(load, 2000);
    return () => {
      clearInterval(interval);
      abortUpload.current?.abort();
    };
  }, [id]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);
  function apply(next: EditDoc, record = true) {
    if (!writable || renderBusy) return;
    if (record) {
      history.current.past.push(structuredClone(current.current));
      if (history.current.past.length > 50) history.current.past.shift();
      history.current.future = [];
      setHist((h) => h + 1);
    }
    current.current = next;
    dirty.current = true;
    setDoc(next);
    setStatus("dirty");
  }
  function mutate(fn: (d: EditDoc) => void) {
    const next = structuredClone(current.current);
    fn(next);
    apply(next);
  }
  function undo(redo = false) {
    if (!writable) return;
    const h = history.current,
      from = redo ? h.future : h.past,
      to = redo ? h.past : h.future;
    const next = from.pop();
    if (!next) return;
    to.push(structuredClone(current.current));
    apply(next, false);
    setHist((x) => x + 1);
  }
  async function save() {
    if (saving.current) return saving.current;
    if (!dirty.current || !writable) return;
    if (conflict.current) throw new Error("Sürüm çakışmasını önce çöz.");
    const snapshot = structuredClone(current.current),
      savedName = currentName.current;
    setStatus("saving");
    const task = (async () => {
      try {
        const p = await api<{ revision: number }>("/projects/" + id, "PUT", {
          name: savedName,
          revision: currentRevision.current,
          document: snapshot,
        });
        currentRevision.current = p.revision;
        setRevision(p.revision);
        if (
          JSON.stringify(current.current) === JSON.stringify(snapshot) &&
          currentName.current === savedName
        ) {
          dirty.current = false;
          setStatus("saved");
        } else setStatus("dirty");
      } catch (e) {
        setStatus("error");
        if (e instanceof ApiError && e.status === 409) conflict.current = true;
        throw e;
      }
    })();
    saving.current = task;
    try {
      await task;
    } finally {
      saving.current = null;
    }
  }
  useEffect(() => {
    if (!dirty.current || !writable || conflict.current) return;
    const timer = setTimeout(() => save().catch(fail), 900);
    return () => clearTimeout(timer);
  }, [doc, name, writable, revision]);
  function seek(n: number) {
    const t = Math.max(0, Math.min(n, total));
    playhead.current = t;
    setTime(t);
  }
  useEffect(() => {
    playhead.current = Math.min(playhead.current, total);
    setTime(playhead.current);
    if (total === 0) setPlaying(false);
  }, [total]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now(),
      raf = 0;
    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      if (delta >= 1 / 30) {
        last = now;
        const t = Math.min(total, playhead.current + delta);
        playhead.current = t;
        setTime(t);
        if (t >= total) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (playhead.current >= total) {
      playhead.current = 0;
      setTime(0);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  useEffect(() => {
    const v = video.current;
    if (!v || !active) return;
    const target = active.clip.in + active.local;
    try {
      if (!playing || Math.abs(v.currentTime - target) > 0.22)
        v.currentTime = target;
      v.volume = Math.min(1, active.clip.volume);
      v.muted = active.clip.muted;
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing) v.pause();
    } catch (_) {}
  }, [time, playing, active?.clip.id, activeAsset?.proxy, ready]);
  useEffect(() => {
    const a = audio.current;
    if (!a || !music) return;
    try {
      const target = time % music.duration;
      if (!playing || Math.abs(a.currentTime - target) > 0.3)
        a.currentTime = target;
      a.volume = doc.musicVolume;
      if (playing && a.paused) a.play().catch(() => {});
      if (!playing) a.pause();
    } catch (_) {}
  }, [time, playing, music?.id, doc.musicVolume, ready]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver((entries) =>
      setStageHeight(entries[0].contentRect.height),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [!!bundle, doc.format]);
  function add(asset: Asset) {
    if (asset.state !== "ready") return;
    if (asset.kind === "audio") {
      mutate((d) => {
        d.musicId = asset.id;
      });
      return;
    }
    if (asset.duration < 0.2) {
      setError("Video en az 0,2 saniye olmalı.");
      return;
    }
    const clip: Clip = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      in: 0,
      out: Math.min(asset.duration, 10),
      volume: 1,
      muted: false,
      title: "",
      titleSize: 56,
      titlePosition: "bottom",
      transition: "cut",
    };
    mutate((d) => d.clips.push(clip));
    setSelection(clip.id);
    setRightTab("clip");
  }
  function update(patch: Partial<Clip>) {
    if (!selected) return;
    mutate((d) => {
      const c = d.clips.find((c) => c.id === selected.id);
      if (c) Object.assign(c, patch);
    });
  }
  function remove() {
    if (!selected) return;
    mutate((d) => {
      d.clips = d.clips.filter((c) => c.id !== selected.id);
    });
    setSelection("");
  }
  function split() {
    const point = locate(current.current, playhead.current);
    if (
      !point ||
      point.local < 0.2 ||
      point.clip.out - point.clip.in - point.local < 0.2
    ) {
      setError(
        "Klip içinde en az 0,2 saniye kenar boşluğu olan bir nokta seç.",
      );
      return;
    }
    mutate((d) => {
      const c = d.clips[point.index];
      const second = {
        ...c,
        id: crypto.randomUUID(),
        in: c.in + point.local,
        title: "",
      };
      c.out = second.in;
      d.clips.splice(point.index + 1, 0, second);
    });
    setPlaying(false);
  }
  keyHandler.current = (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("input,textarea,select,[contenteditable=true]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo(e.shiftKey);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save().catch(fail);
    } else if (e.code === "Space") {
      e.preventDefault();
      if (total) setPlaying((p) => !p);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  async function uploadFile(file: File) {
    if (!writable || upload) return;
    if (file.size > 200 * 1024 * 1024) {
      setError("Dosya en fazla 200 MB olabilir.");
      return;
    }
    const controller = new AbortController();
    abortUpload.current = controller;
    setUpload({ name: file.name, progress: 0, stage: "Dosya doğrulanıyor" });
    setError("");
    try {
      const hex = (b: ArrayBuffer) =>
        Array.from(new Uint8Array(b))
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
      const hash = hex(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      );
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const key = hex(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(hash + "|" + file.name),
        ),
      );
      const u = await api<{
        id: string;
        received: number;
        assetId: string | null;
      }>("/projects/" + id + "/uploads", "POST", {
        name: file.name,
        total: file.size,
        hash,
        key,
      });
      let offset = u.received;
      while (!u.assetId && offset < file.size) {
        const end = Math.min(offset + 4 * 1024 * 1024, file.size);
        const r = await fetch("/api/uploads/" + u.id + "?offset=" + offset, {
          method: "PUT",
          body: file.slice(offset, end),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error((await r.json()).error);
        offset = (await r.json()).received;
        setUpload({
          name: file.name,
          progress: offset / file.size,
          stage: "Yükleniyor",
        });
      }
      if (!u.assetId) await api("/uploads/" + u.id + "/complete", "POST");
      await load();
      setUpload(null);
    } catch (e) {
      setUpload(null);
      if ((e as Error).name === "AbortError")
        setError(
          "Yükleme durduruldu. Aynı dosyayı tekrar seçerek devam edebilirsin.",
        );
      else fail(e);
    } finally {
      abortUpload.current = null;
    }
  }
  async function render() {
    setRenderBusy(true);
    setError("");
    try {
      await save();
      if (dirty.current) await save();
      if (dirty.current) throw new Error("Taslak henüz kaydedilmedi.");
      await api("/projects/" + id + "/renders", "POST", {
        key: crypto.randomUUID(),
        revision: currentRevision.current,
        preset,
      });
      setExporting(false);
      setRightTab("exports");
      setShowProperties(true);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setRenderBusy(false);
    }
  }
  function drop(e: React.DragEvent, target?: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!writable) return;
    const assetId = e.dataTransfer.getData("application/framelab-asset");
    if (assetId) {
      const a = bundle?.assets.find((a) => a.id === assetId);
      if (a) add(a);
      return;
    }
    const moving = e.dataTransfer.getData("application/framelab-clip");
    if (moving && moving !== target)
      mutate((d) => {
        const index = d.clips.findIndex((c) => c.id === moving);
        if (index < 0) return;
        const [clip] = d.clips.splice(index, 1);
        const at = target
          ? d.clips.findIndex((c) => c.id === target)
          : d.clips.length;
        d.clips.splice(Math.max(0, at), 0, clip);
      });
  }
  function startTrim(e: React.PointerEvent, clip: Clip, edge: string) {
    if (!writable) return;
    e.stopPropagation();
    e.preventDefault();
    setPlaying(false);
    setSelection(clip.id);
    history.current.past.push(structuredClone(current.current));
    history.current.future = [];
    setHist((h) => h + 1);
    trim.current = {
      id: clip.id,
      edge,
      x: e.clientX,
      in: clip.in,
      out: clip.out,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveTrim(e: React.PointerEvent) {
    if (!trim.current || !e.currentTarget.hasPointerCapture(e.pointerId))
      return;
    const t = trim.current,
      delta = (e.clientX - t.x) / zoom;
    const next = structuredClone(current.current),
      clip = next.clips.find((c) => c.id === t.id),
      asset = bundle?.assets.find((a) => a.id === clip?.assetId);
    if (!clip || !asset) return;
    if (t.edge === "in")
      clip.in =
        Math.round(Math.max(0, Math.min(t.in + delta, clip.out - 0.2)) * 100) /
        100;
    else
      clip.out =
        Math.round(
          Math.min(asset.duration, Math.max(t.out + delta, clip.in + 0.2)) *
            100,
        ) / 100;
    apply(next, false);
  }
  function downloadDraft() {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { name: currentName.current, document: current.current },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "framelab-draft.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!bundle)
    return (
      <div className="loading">{error || "Kurgu masası hazırlanıyor…"}</div>
    );
  const busyJob = bundle.jobs.find((j) =>
      ["queued", "running", "cancel_requested"].includes(j.state),
    ),
    assets = bundle.assets.filter(
      (a) => mediaTab === "all" || a.kind === mediaTab,
    ),
    fade =
      active?.clip.transition === "fade"
        ? Math.min(
            1,
            active.local / 0.25,
            (active.clip.out - active.clip.in - active.local) / 0.25,
          )
        : 1;
  return (
    <div className="editor">
      <header className="editor-header">
        <button
          className="icon-button"
          aria-label="Projelere dön"
          onClick={() => {
            if (
              dirty.current &&
              !confirm("Kaydedilmemiş taslak var. Yine de çıkılsın mı?")
            )
              return;
            onBack();
          }}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="editor-logo">
          <Clapperboard size={23} />
        </span>
        <div className="project-name">
          <input
            aria-label="Proje adı"
            value={name}
            disabled={!writable}
            onChange={(e) => {
              currentName.current = e.target.value;
              dirty.current = true;
              setName(e.target.value);
              setStatus("dirty");
            }}
          />
          <span>
            v{revision} <i />{" "}
            {bundle.role === "viewer"
              ? "Salt okunur"
              : status === "saving"
                ? "Kaydediliyor…"
                : status === "dirty"
                  ? "Kaydedilmedi"
                  : status === "error"
                    ? "Kayıt gerekli"
                    : "Tüm değişiklikler kaydedildi"}
          </span>
        </div>
        <div className="editor-actions">
          <button
            className="icon-button"
            aria-label="Projeyi kaydet"
            disabled={!writable}
            onClick={() => save().catch(fail)}
          >
            <Save size={16} />
          </button>
          {bundle.role === "owner" && (
            <button aria-label="Paylaş" onClick={() => setShare(true)}>
              <Share2 size={15} />
              <span>Paylaş</span>
            </button>
          )}
          <button
            onClick={() => {
              setRightTab("comments");
              setShowProperties(true);
            }}
            aria-label="Yorumları aç"
          >
            <MessageSquare size={16} />
            <span>{bundle.comments.length}</span>
          </button>
          <button
            className="primary"
            aria-label="Dışa aktar"
            disabled={!writable || !doc.clips.length}
            onClick={() => setExporting(true)}
          >
            <ArrowUpRight size={16} />
            <span>Dışa aktar</span>
          </button>
        </div>
      </header>
      {error && (
        <div className="editor-error" role="alert">
          {error}
          <div>
            {conflict.current && (
              <>
                <button onClick={downloadDraft}>Taslağı indir</button>
                <button
                  onClick={() => {
                    if (
                      !confirm(
                        "Yerel taslak yerine sunucudaki sürüm yüklensin mi?",
                      )
                    )
                      return;
                    conflict.current = false;
                    dirty.current = false;
                    initialized.current = false;
                    setError("");
                    load();
                  }}
                >
                  Sunucudakini yükle
                </button>
              </>
            )}
            <button aria-label="Hatayı kapat" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      <div className="editor-main">
        <aside
          className="media-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) uploadFile(f);
          }}
        >
          <div className="panel-title">
            <h2>Medya kitaplığı</h2>
            <button
              className="icon-button"
              aria-label="Medya yükle"
              disabled={!writable || !!upload}
              onClick={() => picker.current?.click()}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="media-tabs">
            {[
              ["all", "Tümü"],
              ["video", "Video"],
              ["audio", "Ses"],
            ].map(([k, v]) => (
              <button
                className={mediaTab === k ? "active" : ""}
                key={k}
                onClick={() => setMediaTab(k)}
              >
                {v}
              </button>
            ))}
          </div>
          <input
            ref={picker}
            type="file"
            aria-label="Video veya ses dosyası"
            hidden
            accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/flac,.m4v,.m4a"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) uploadFile(f);
            }}
          />
          {upload ? (
            <div className="upload-state">
              <LoaderCircle className="spin" size={22} />
              <b>{upload.name}</b>
              <span>
                {upload.stage} · %{Math.round(upload.progress * 100)}
              </span>
              <progress value={upload.progress} max={1} />
              <button onClick={() => abortUpload.current?.abort()}>
                Durdur
              </button>
            </div>
          ) : (
            <button
              className="upload-zone"
              disabled={!writable}
              onClick={() => picker.current?.click()}
            >
              <UploadCloud size={23} />
              <b>Medya ekle</b>
              <span>
                Dosyayı buraya bırak
                <br />
                veya bilgisayarından seç.
              </span>
              <small>Video / Ses · En fazla 200 MB</small>
            </button>
          )}
          <div className="media-grid">
            {assets.map((a) => (
              <div
                className={
                  "media-card " + (a.state !== "ready" ? "processing" : "")
                }
                key={a.id}
                draggable={writable && a.state === "ready"}
                onDragStart={(e) =>
                  e.dataTransfer.setData("application/framelab-asset", a.id)
                }
              >
                <div className="media-cover">
                  {a.poster ? (
                    <img src={a.poster} alt="" />
                  ) : a.state === "ready" && a.kind === "audio" ? (
                    <Music2 size={24} />
                  ) : a.state === "failed" ? (
                    <X size={24} />
                  ) : (
                    <LoaderCircle className="spin" size={23} />
                  )}
                  <span>
                    {a.state === "ready"
                      ? clock(a.duration)
                      : a.state === "failed"
                        ? "İşlenemedi"
                        : "Hazırlanıyor"}
                  </span>
                  {a.state === "ready" && (
                    <button
                      disabled={!writable}
                      aria-label={a.name + " ekle"}
                      onClick={() => add(a)}
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </div>
                <b title={a.name}>{a.name}</b>
                <small>
                  {a.kind === "audio"
                    ? "SES"
                    : a.width
                      ? a.width + " × " + a.height
                      : "MEDYA"}{" "}
                  · {size(a.bytes)}
                </small>
                {a.error && <small className="asset-error">{a.error}</small>}
                {a.state === "failed" && writable && (
                  <button
                    className="retry-media"
                    onClick={async () => {
                      try {
                        const job = bundle.jobs.find(
                          (j) =>
                            j.kind === "ingest" &&
                            j.assetId === a.id &&
                            ["failed", "cancelled"].includes(j.state),
                        );
                        if (!job) throw new Error("İşlem geçmişi bulunamadı.");
                        await api("/jobs/" + job.id + "/retry", "POST");
                        await load();
                      } catch (e) {
                        fail(e);
                      }
                    }}
                  >
                    Yeniden dene
                  </button>
                )}
              </div>
            ))}
          </div>
          {busyJob && busyJob.kind !== "render" && (
            <div className="library-job">
              <LoaderCircle size={12} className="spin" />
              {busyJob.stage}
              <progress max={1} value={busyJob.progress} />
            </div>
          )}
          <div className="media-footer">
            <span>{bundle.assets.length} DOSYA</span>
            <span>{writable ? "Sürükle / Ekle" : "Görüntüleme modu"}</span>
          </div>
        </aside>
        <section className="viewer-panel">
          <div className="viewer-top">
            <span>ÖNİZLEME</span>
            <div>
              <span>
                {doc.format === "portrait"
                  ? "9:16"
                  : doc.format === "square"
                    ? "1:1"
                    : "16:9"}
              </span>
              <button
                className="icon-button"
                aria-label="Klip özelliklerini aç"
                onClick={() => {
                  setRightTab("clip");
                  setShowProperties((p) => !p);
                }}
              >
                <Settings2 size={16} />
              </button>
            </div>
          </div>
          <div className="stage-surround">
            <div ref={stage} className={"stage " + doc.format}>
              {activeAsset?.proxy ? (
                <>
                  <video
                    key={activeAsset.id}
                    ref={video}
                    src={activeAsset.proxy}
                    playsInline
                    preload="auto"
                    onLoadedMetadata={() => setReady((n) => n + 1)}
                    style={{ opacity: Math.max(0, fade) }}
                  />
                  {active?.clip.title && (
                    <div
                      className={"preview-title " + active.clip.titlePosition}
                      style={{
                        fontSize: (active.clip.titleSize * stageHeight) / 1080,
                        opacity: Math.max(0, fade),
                      }}
                    >
                      {active.clip.title}
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-view">
                  <Clapperboard size={36} />
                  <h3>İlk kareni ekle.</h3>
                  <p>
                    Medya kitaplığından bir videoyu
                    <br />
                    zaman çizelgesine sürükle.
                  </p>
                </div>
              )}
            </div>
          </div>
          {music?.proxy && (
            <audio
              ref={audio}
              src={music.proxy}
              loop
              onLoadedMetadata={() => setReady((n) => n + 1)}
            />
          )}
          <div className="playback">
            <span>
              {clock(time)} <i>/ {clock(total)}</i>
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Başa dön"
                onClick={() => seek(0)}
              >
                <SkipBack size={16} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? "Duraklat" : "Oynat"}
                disabled={!total}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button
                className="icon-button"
                aria-label="Zaman çizelgesinin sonuna git"
                onClick={() => {
                  seek(total);
                  setPlaying(false);
                }}
              >
                <SkipBack size={16} style={{ transform: "rotate(180deg)" }} />
              </button>
            </div>
            <span className="viewer-resolution">
              30 FPS ·{" "}
              {doc.format === "portrait"
                ? "1080 × 1920"
                : doc.format === "square"
                  ? "1080 × 1080"
                  : "1920 × 1080"}
            </span>
          </div>
        </section>
        <aside className={"properties " + (showProperties ? "open" : "")}>
          <div className="property-tabs">
            <button
              className={rightTab === "clip" ? "active" : ""}
              onClick={() => setRightTab("clip")}
            >
              Özellikler
            </button>
            <button
              className={rightTab === "comments" ? "active" : ""}
              onClick={() => setRightTab("comments")}
            >
              <MessageSquare size={14} />
            </button>
            <button
              className={rightTab === "exports" ? "active" : ""}
              onClick={() => setRightTab("exports")}
            >
              <ArrowDownToLine size={14} />
            </button>
            <button
              className="close-properties icon-button"
              aria-label="Özellikleri kapat"
              onClick={() => setShowProperties(false)}
            >
              <X size={16} />
            </button>
          </div>
          {rightTab === "clip" && (
            <div className="property-body">
              <span className="eyebrow">PROJE AYARLARI</span>
              <label>
                Çerçeve
                <select
                  disabled={!writable}
                  value={doc.format}
                  onChange={(e) =>
                    mutate((d) => {
                      d.format = e.target.value as EditDoc["format"];
                    })
                  }
                >
                  <option value="landscape">Yatay · 16:9</option>
                  <option value="portrait">Dikey · 9:16</option>
                  <option value="square">Kare · 1:1</option>
                </select>
              </label>
              {selected && selectedAsset ? (
                <>
                  <div className="property-section">
                    <span className="eyebrow">SEÇİLİ KLİP</span>
                    <h3>{selectedAsset.name}</h3>
                    <div className="two-fields">
                      <label>
                        Giriş (sn)
                        <input
                          aria-label="Klip giriş saniyesi"
                          type="number"
                          step="0.1"
                          min={0}
                          max={selected.out - 0.2}
                          value={selected.in}
                          disabled={!writable}
                          onChange={(e) =>
                            update({
                              in: Math.max(
                                0,
                                Math.min(+e.target.value, selected.out - 0.2),
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        Çıkış (sn)
                        <input
                          aria-label="Klip çıkış saniyesi"
                          type="number"
                          step="0.1"
                          min={selected.in + 0.2}
                          max={selectedAsset.duration}
                          value={selected.out}
                          disabled={!writable}
                          onChange={(e) =>
                            update({
                              out: Math.min(
                                selectedAsset.duration,
                                Math.max(selected.in + 0.2, +e.target.value),
                              ),
                            })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Geçiş
                      <select
                        disabled={!writable}
                        value={selected.transition}
                        onChange={(e) =>
                          update({
                            transition: e.target.value as Clip["transition"],
                          })
                        }
                      >
                        <option value="cut">Doğrudan kesme</option>
                        <option value="fade">Siyaha açıl / karar</option>
                      </select>
                    </label>
                  </div>
                  <div className="property-section">
                    <span className="eyebrow">BAŞLIK</span>
                    <textarea
                      aria-label="Klip başlığı"
                      placeholder="Kareye bir şey ekle…"
                      maxLength={120}
                      value={selected.title}
                      disabled={!writable}
                      onChange={(e) => update({ title: e.target.value })}
                    />
                    <label>
                      Yazı boyutu <span>{selected.titleSize} px</span>
                      <input
                        aria-label="Başlık yazı boyutu"
                        type="range"
                        min={16}
                        max={96}
                        value={selected.titleSize}
                        disabled={!writable}
                        onChange={(e) => update({ titleSize: +e.target.value })}
                      />
                    </label>
                    <label>
                      Konum
                      <select
                        disabled={!writable}
                        value={selected.titlePosition}
                        onChange={(e) =>
                          update({
                            titlePosition: e.target
                              .value as Clip["titlePosition"],
                          })
                        }
                      >
                        <option value="bottom">Alt / Ortalı</option>
                        <option value="center">Merkez</option>
                      </select>
                    </label>
                  </div>
                  <div className="property-section">
                    <span className="eyebrow">KLİP SESİ</span>
                    <label>
                      Ses seviyesi{" "}
                      <span>%{Math.round(selected.volume * 100)}</span>
                      <input
                        aria-label="Klip ses seviyesi"
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selected.volume}
                        disabled={!writable}
                        onChange={(e) => update({ volume: +e.target.value })}
                      />
                    </label>
                    <button
                      className={
                        "mute-button " + (selected.muted ? "muted" : "")
                      }
                      disabled={!writable}
                      onClick={() => update({ muted: !selected.muted })}
                    >
                      {selected.muted ? (
                        <VolumeX size={15} />
                      ) : (
                        <Volume2 size={15} />
                      )}{" "}
                      {selected.muted ? "Ses kapalı" : "Sesi kapat"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="property-empty">
                  <Settings2 size={25} />
                  <p>
                    Zaman çizelgesinden
                    <br />
                    bir klip seç.
                  </p>
                </div>
              )}
              {music && (
                <div className="property-section">
                  <span className="eyebrow">MÜZİK</span>
                  <p>{music.name}</p>
                  <label>
                    Seviye
                    <input
                      aria-label="Müzik ses seviyesi"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={!writable}
                      value={doc.musicVolume}
                      onChange={(e) =>
                        mutate((d) => {
                          d.musicVolume = +e.target.value;
                        })
                      }
                    />
                  </label>
                  <button
                    disabled={!writable}
                    onClick={() =>
                      mutate((d) => {
                        d.musicId = null;
                      })
                    }
                  >
                    Müziği kaldır
                  </button>
                </div>
              )}
              <div className="property-section versions">
                <span className="eyebrow">PROJE GEÇMİŞİ</span>
                {bundle.versions.slice(0, 6).map((v) => (
                  <button
                    key={v.revision}
                    disabled={!writable || v.revision === revision}
                    onClick={async () => {
                      if (
                        !confirm(
                          "Bu sürüm yeni bir kayıt olarak geri yüklensin mi? Kaydedilmemiş taslak değişir.",
                        )
                      )
                        return;
                      try {
                        await api(
                          "/projects/" + id + "/restore/" + v.revision,
                          "POST",
                          { revision: currentRevision.current },
                        );
                        dirty.current = false;
                        initialized.current = false;
                        await load();
                      } catch (e) {
                        fail(e);
                      }
                    }}
                  >
                    <Clock size={12} /> Sürüm {v.revision}
                    <small>{date(v.created)}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {rightTab === "comments" && (
            <div className="property-body">
              <span className="eyebrow">KAREYE BİR NOT BIRAK</span>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api("/projects/" + id + "/comments", "POST", {
                      text: note,
                      at: time,
                    });
                    setNote("");
                    await load();
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                <textarea
                  aria-label="Yorum"
                  placeholder="Bu kare hakkında…"
                  required
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="comment-submit">
                  <span>{clock(time)}</span>
                  <button className="primary">Gönder</button>
                </div>
              </form>
              {bundle.comments.map((c) => (
                <article className="comment" key={c.id}>
                  <div>
                    <span className="avatar">{c.author.slice(0, 1)}</span>
                    <b>{c.author}</b>
                    <button onClick={() => seek(c.at)}>{clock(c.at)}</button>
                  </div>
                  <p>{c.text}</p>
                  <small>{date(c.created)}</small>
                </article>
              ))}
            </div>
          )}
          {rightTab === "exports" && (
            <div className="property-body exports">
              <span className="eyebrow">ÇIKTI GEÇMİŞİ</span>
              {bundle.jobs.filter((j) => j.kind === "render").length === 0 && (
                <div className="property-empty">
                  <ArrowDownToLine size={26} />
                  <p>
                    İlk çıktın burada
                    <br />
                    yerini alacak.
                  </p>
                </div>
              )}
              {bundle.jobs
                .filter((j) => j.kind === "render")
                .map((j) => (
                  <JobCard
                    key={j.id}
                    job={j}
                    writable={!!writable}
                    act={async (action) => {
                      try {
                        await api("/jobs/" + j.id + "/" + action, "POST");
                        await load();
                      } catch (e) {
                        fail(e);
                      }
                    }}
                  />
                ))}
            </div>
          )}
        </aside>
      </div>
      <section className="timeline">
        <div className="timeline-toolbar">
          <div>
            <button
              aria-label="Geri al"
              disabled={!writable || !history.current.past.length}
              onClick={() => undo()}
            >
              <Undo2 size={16} />
            </button>
            <button
              aria-label="Yinele"
              disabled={!writable || !history.current.future.length}
              onClick={() => undo(true)}
            >
              <Redo2 size={16} />
            </button>
            <i />
            <button
              aria-label="Klibi böl"
              disabled={!writable || !doc.clips.length}
              onClick={split}
            >
              <Scissors size={15} />
              <span>Böl</span>
            </button>
            <button
              aria-label="Seçili klibi çoğalt"
              disabled={!writable || !selected}
              onClick={() => {
                if (selected)
                  mutate((d) => {
                    const i = d.clips.findIndex((c) => c.id === selected.id);
                    d.clips.splice(i + 1, 0, {
                      ...d.clips[i],
                      id: crypto.randomUUID(),
                    });
                  });
              }}
            >
              <Copy size={15} />
            </button>
            <button
              aria-label="Seçili klibi sil"
              disabled={!writable || !selected}
              onClick={remove}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <span className="timeline-label">
            ZAMAN ÇİZELGESİ <b>{doc.clips.length} KLİP</b>
          </span>
          <div>
            <span>{clock(time)}</span>
            <input
              aria-label="Zaman çizelgesi yakınlaştırma"
              type="range"
              min={15}
              max={80}
              value={zoom}
              onChange={(e) => setZoom(+e.target.value)}
            />
          </div>
        </div>
        <div className="timeline-content">
          <div className="track-labels">
            <span />
            <div>
              <Film size={15} />
              <b>V1</b>
              <small>Görüntü</small>
            </div>
            <div>
              <Type size={15} />
              <b>T1</b>
              <small>Başlık</small>
            </div>
            <div>
              <Headphones size={15} />
              <b>A1</b>
              <small>Ses</small>
            </div>
          </div>
          <div className="timeline-scroll">
            <div
              className="tracks"
              style={{ width: Math.max(700, total * zoom + 180) }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => drop(e)}
            >
              <div
                className="ruler"
                aria-label="Oynatma konumu"
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seek((e.clientX - rect.left) / zoom);
                }}
              >
                {Array.from(
                  {
                    length: Math.ceil(Math.max(700 / zoom, total + 4) / 5) + 1,
                  },
                  (_, i) => (
                    <span key={i} style={{ left: i * 5 * zoom }}>
                      {clock(i * 5).slice(0, 5)}
                    </span>
                  ),
                )}
              </div>
              <div className="video-track">
                {doc.clips.map((clip, index) => {
                  const asset = bundle.assets.find(
                    (a) => a.id === clip.assetId,
                  );
                  return (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        "Klip " + (index + 1) + " " + (asset?.name || "")
                      }
                      className={
                        "timeline-clip " +
                        (selection === clip.id ? "selected" : "")
                      }
                      style={{
                        width: (clip.out - clip.in) * zoom,
                        backgroundImage: asset?.poster
                          ? `url(${asset.poster})`
                          : undefined,
                      }}
                      draggable={!!writable}
                      onDragStart={(e) =>
                        e.dataTransfer.setData(
                          "application/framelab-clip",
                          clip.id,
                        )
                      }
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => drop(e, clip.id)}
                      onClick={() => {
                        setSelection(clip.id);
                        setRightTab("clip");
                        seek(
                          doc.clips
                            .slice(0, index)
                            .reduce((n, c) => n + c.out - c.in, 0),
                        );
                        setPlaying(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setSelection(clip.id);
                          setRightTab("clip");
                        }
                      }}
                    >
                      <span className="clip-caption">{asset?.name}</span>
                      <small>{clock(clip.out - clip.in)}</small>
                      {["in", "out"].map((edge) => (
                        <span
                          key={edge}
                          className={"trim-handle " + edge}
                          onPointerDown={(e) => startTrim(e, clip, edge)}
                          onPointerMove={moveTrim}
                          onPointerUp={() => {
                            trim.current = null;
                          }}
                          onPointerCancel={() => {
                            trim.current = null;
                          }}
                        />
                      ))}
                      {clip.transition === "fade" && (
                        <i className="fade-mark" />
                      )}
                    </div>
                  );
                })}
                {!doc.clips.length && (
                  <div className="timeline-empty">
                    <Plus size={17} /> Bir videoyu buraya sürükle.
                  </div>
                )}
              </div>
              <div className="text-track">
                {doc.clips.map((c) => (
                  <div
                    key={c.id}
                    style={{ width: (c.out - c.in) * zoom }}
                    className={c.title ? "has-title" : ""}
                    onClick={() => {
                      setSelection(c.id);
                      setRightTab("clip");
                      setShowProperties(true);
                    }}
                  >
                    {c.title && (
                      <>
                        <Type size={12} />
                        <span>{c.title}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div
                className="audio-track"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e)}
              >
                {music ? (
                  <div
                    className="music-block"
                    style={{
                      width: total * zoom,
                      backgroundImage: music.wave
                        ? `url(${music.wave})`
                        : undefined,
                    }}
                  >
                    <Music2 size={13} />
                    {music.name}
                  </div>
                ) : doc.clips.some(
                    (c) =>
                      bundle.assets.find((a) => a.id === c.assetId)?.hasAudio,
                  ) ? (
                  doc.clips.map((c) => {
                    const a = bundle.assets.find((a) => a.id === c.assetId);
                    return (
                      <div
                        className="clip-wave"
                        key={c.id}
                        style={{
                          width: (c.out - c.in) * zoom,
                          opacity: c.muted ? 0.25 : 1,
                          backgroundImage: a?.wave
                            ? `url(${a.wave})`
                            : undefined,
                        }}
                      >
                        {a?.hasAudio ? (
                          c.muted ? (
                            <VolumeX size={12} />
                          ) : (
                            <Volume2 size={12} />
                          )
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="audio-empty">
                    <Music2 size={14} /> Bir ses dosyası ekle.
                  </div>
                )}
              </div>
              <div className="playhead" style={{ left: time * zoom }}>
                <i />
              </div>
            </div>
          </div>
        </div>
        <div className="timeline-footer">
          <span>
            <span className="status-dot" />{" "}
            {busyJob ? busyJob.stage : "Çalışma alanı hazır"}
          </span>
          <span>
            SPACE Oynat / Duraklat <i>·</i> CTRL Z Geri al <i>·</i> DELETE Sil
          </span>
          <span>{clock(total)} TOPLAM</span>
        </div>
      </section>
      {exporting && (
        <div className="overlay">
          <section className="export-dialog">
            <button
              className="close"
              aria-label="Dışa aktarmayı kapat"
              onClick={() => setExporting(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">SON BİR BAKIŞ.</span>
            <h2>Hikâyen dışarı çıksın.</h2>
            <p>
              Kaydedilen bu sürüm arka planda hazırlanır. Düzenlemeye devam
              edebilirsin.
            </p>
            <div className="export-summary">
              <Film size={24} />
              <div>
                <b>{name}</b>
                <span>
                  {clock(total)} · {doc.clips.length} klip · 30 fps
                </span>
              </div>
            </div>
            <label>
              Çıktı kalitesi
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
              >
                <option value="1080p">Full HD · 1080p</option>
                <option value="720p">Hızlı çıktı · 720p</option>
              </select>
            </label>
            <div className="export-spec">
              <span>MP4 / H.264</span>
              <span>AAC / 48 kHz</span>
            </div>
            {busyJob && (
              <p className="warning">
                Projenin önceki işlemini bekle: {busyJob.stage}
              </p>
            )}
            <button
              className="primary"
              onClick={render}
              disabled={renderBusy || !!busyJob}
            >
              {renderBusy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowUpRight size={17} />
              )}{" "}
              Render başlat
            </button>
          </section>
        </div>
      )}
      {share && (
        <ShareDialog
          id={id}
          admin={user.admin}
          onClose={() => setShare(false)}
          onError={fail}
        />
      )}
    </div>
  );
}
function JobCard({
  job: j,
  writable,
  act,
}: {
  job: Job;
  writable: boolean;
  act: (action: string) => void;
}) {
  return (
    <article className={"job-card " + j.state}>
      <div>
        <Film size={16} />
        <b>MP4 çıktı</b>
        <span>{date(j.created)}</span>
      </div>
      <p>{j.stage}</p>
      {["queued", "running", "cancel_requested"].includes(j.state) && (
        <>
          <progress value={j.progress} max={1} />
          <small>
            %{Math.round(j.progress * 100)} · Deneme {j.attempt || 1}
          </small>
          {writable && (
            <button
              disabled={j.state === "cancel_requested"}
              onClick={() => act("cancel")}
            >
              {j.state === "cancel_requested" ? "İptal ediliyor…" : "İptal et"}
            </button>
          )}
        </>
      )}
      {j.error && <p className="asset-error">{j.error}</p>}
      {j.download && (
        <a className="primary" href={j.download}>
          <ArrowDownToLine size={14} /> MP4 indir
        </a>
      )}
      {["failed", "cancelled"].includes(j.state) && writable && (
        <button onClick={() => act("retry")}>
          <RotateCcw size={13} /> Yeniden dene
        </button>
      )}
    </article>
  );
}
function ShareDialog({
  id,
  admin,
  onClose,
  onError,
}: {
  id: string;
  admin: boolean;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [username, setUsername] = useState("deniz"),
    [role, setRole] = useState("viewer"),
    [people, setPeople] = useState<{
      owner: { id: string; name: string; username: string };
      members: { id: string; name: string; username: string; role: string }[];
    } | null>(null);
  const load = () =>
    api<typeof people>("/projects/" + id + "/members").then(setPeople);
  useEffect(() => {
    load().catch(onError);
  }, []);
  return (
    <div className="overlay">
      <section className="share-dialog">
        <button
          className="close"
          aria-label="Paylaşımı kapat"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">BİRLİKTE DAHA İYİ.</span>
        <h2>Projeye birini davet et.</h2>
        <p>
          İzleyiciler yorum bırakabilir; düzenleyiciler kurgu ve çıktı
          oluşturabilir.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/projects/" + id + "/members", "POST", {
                username,
                role,
              });
              await load();
            } catch (e) {
              onError(e);
            }
          }}
        >
          <label>
            Kullanıcı adı
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            Yetki
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">İzleyici + Yorum</option>
              <option value="editor">Düzenleyici</option>
            </select>
          </label>
          <button className="primary">
            <Plus size={15} /> Erişim ver
          </button>
        </form>
        <div className="members">
          {people && (
            <article>
              <span className="avatar">{people.owner.name[0]}</span>
              <div>
                <b>{people.owner.name}</b>
                <small>{people.owner.username}</small>
              </div>
              <span>Proje sahibi</span>
            </article>
          )}
          {people?.members.map((m) => (
            <article key={m.id}>
              <span className="avatar">{m.name[0]}</span>
              <div>
                <b>{m.name}</b>
                <small>
                  {m.role === "editor" ? "Düzenleyici" : "İzleyici"}
                </small>
              </div>
              <button
                aria-label={m.name + " erişimini kaldır"}
                onClick={async () => {
                  try {
                    await api("/projects/" + id + "/members/" + m.id, "DELETE");
                    await load();
                  } catch (e) {
                    onError(e);
                  }
                }}
              >
                <X size={14} />
              </button>
            </article>
          ))}
        </div>
        {admin && (
          <small className="share-note">
            Mevcut bir çalışma alanı kullanıcısına erişim ver. Yerel demoda
            deniz hesabını deneyebilirsin.
          </small>
        )}
      </section>
    </div>
  );
}
