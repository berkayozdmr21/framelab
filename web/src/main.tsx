import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  Clapperboard,
  Film,
  FolderOpen,
  Plus,
  LogOut,
  Play,
  Search,
  ChevronRight,
  LoaderCircle,
  Layers,
  MonitorPlay,
} from "lucide-react";
import {
  api,
  ApiError,
  clock,
  date,
  type User,
  type ProjectCard,
} from "./domain";
import { Editor } from "./Editor";
import "./style.css";
export function Brand() {
  return (
    <a className="brand" href="/">
      <span>
        <Clapperboard size={23} />
      </span>
      framelab<i>STUDIO</i>
    </a>
  );
}
function Login({
  onLogin,
  development,
}: {
  onLogin: (u: User) => void;
  development: boolean;
}) {
  const [username, setUsername] = useState("berkay"),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (development) setPassword((p) => p || "Framelab2026!");
  }, [development]);
  return (
    <div className="login">
      <section>
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">DAHA AZ ARAÇ. DAHA ÇOK HİKÂYE.</span>
          <h1>
            Bir fikrin
            <br />
            ilk <em>karesi.</em>
          </h1>
          <p>
            Görüntüleri bir araya getir.
            <br />
            Ritmini bul. Hikâyeni paylaş.
          </p>
          <div className="film-art">
            <span>01 / MOTION STUDY</span>
            <div />
            <b>
              MAKE
              <br />
              ROOM.
            </b>
            <i>FOR WHAT'S NEXT.</i>
            <small>FRAME / LAB / 2026</small>
          </div>
        </div>
        <footer>
          GÖRÜNTÜ. SES. HİKÂYE. <span>FrameLab / 01</span>
        </footer>
      </section>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await api<{ user: User }>("/login", "POST", {
              username,
              password,
            });
            onLogin(r.user);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">ÇALIŞMA ALANINA HOŞ GELDİN</span>
        <h2>Stüdyoyu aç.</h2>
        <p>Projelerin ve bıraktığın son kare burada.</p>
        <label>
          Kullanıcı adı
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          Şifre
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Açılıyor…" : "Çalışma alanına gir"}
          <ArrowUpRight size={17} />
        </button>
        {development && <small>Yerel demo · berkay / Framelab2026!</small>}
      </form>
    </div>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loaded, setLoaded] = useState(false),
    [dev, setDev] = useState(false),
    [projects, setProjects] = useState<ProjectCard[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [worker, setWorker] = useState<number | null>(null);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) {
      setUser(null);
      setSelected(null);
    } else setError((e as Error).message);
  }
  async function list() {
    setProjects(await api<ProjectCard[]>("/projects"));
    setWorker((await api<{ workers: number }>("/system")).workers);
  }
  useEffect(() => {
    api<{ development: boolean }>("/auth-config")
      .then((c) => setDev(c.development))
      .catch(() => {});
    api<User>("/me")
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!user) return;
    list().catch(fail);
    const t = setInterval(() => {
      if (!selected) list().catch(fail);
    }, 10000);
    return () => clearInterval(t);
  }, [user?.id, selected]);
  async function create(demo = false) {
    setBusy(true);
    setError("");
    try {
      const p = await api<{ id: string }>(
        demo ? "/projects/demo" : "/projects",
        "POST",
        demo ? undefined : { name: "İsimsiz proje" },
      );
      setSelected(p.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  if (!loaded) return <div className="loading">FrameLab hazırlanıyor…</div>;
  if (!user) return <Login development={dev} onLogin={setUser} />;
  if (selected)
    return (
      <Editor
        key={selected}
        id={selected}
        user={user}
        onBack={() => {
          setSelected(null);
          setError("");
        }}
        onLogout={() => {
          setUser(null);
          setSelected(null);
        }}
      />
    );
  return (
    <div className="dashboard">
      <aside>
        <Brand />
        <div className="workspace">
          <span className="avatar">BÖ</span>
          <div>
            <b>{user.name}</b>
            <small>Kişisel çalışma alanı</small>
          </div>
        </div>
        <p className="eyebrow">STÜDYO</p>
        <nav>
          <button className="active">
            <FolderOpen size={17} /> Tüm projeler <span>{projects.length}</span>
          </button>
          <button onClick={() => create(true)} disabled={busy}>
            <MonitorPlay size={17} /> Örnek projeyle dene
          </button>
        </nav>
        <div className="aside-note">
          <Clapperboard size={24} />
          <b>Her kare bir başlangıç.</b>
          <p>Dosyalarını ekle, zaman çizelgesini kur ve ilk çıktını al.</p>
        </div>
        <button
          className="logout"
          onClick={async () => {
            await api("/logout", "POST");
            setUser(null);
          }}
        >
          <LogOut size={15} /> Oturumu kapat
        </button>
      </aside>
      <div className="dashboard-body">
        <header>
          <span>
            Çalışma alanı <ChevronRight size={13} /> Projeler
          </span>
          <span>
            <i className={worker ? "status-dot" : "status-dot offline"} />
            {worker === null
              ? "Bağlantı kuruluyor"
              : worker
                ? "Render motoru hazır"
                : "Worker bekleniyor"}
            <span className="avatar">BÖ</span>
          </span>
        </header>
        <main>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="dashboard-title">
            <div>
              <p className="eyebrow">PROJELER / KİŞİSEL STÜDYO</p>
              <h1>Hikâyene yer aç.</h1>
              <p>Bir araya getirmek istediğin tüm kareler için.</p>
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => create()}
            >
              <Plus size={17} /> Yeni proje
            </button>
          </div>
          <section className="studio-feature">
            <div>
              <span className="eyebrow">FİKİRDEN İLK KURGUNA.</span>
              <h2>
                Biraz kes.
                <br />
                Bir araya getir.
                <br />
                <em>Kendinden bir şey kat.</em>
              </h2>
              <p>Videolar, başlıklar ve sesler. Tek bir zaman çizelgesinde.</p>
              <button onClick={() => create(true)} disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Play size={15} />
                )}{" "}
                Örnek projeyi aç <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="hero-frames" aria-hidden="true">
              <div className="frame-back">
                <small>SCENE / 02</small>
                <b>
                  KEEP
                  <br />
                  MOVING.
                </b>
              </div>
              <div className="frame-front">
                <span>
                  FRAME / 01 <i>00:06</i>
                </span>
                <b>
                  MAKE
                  <br />
                  ROOM.
                </b>
                <small>A MOTION STUDY</small>
              </div>
              <div className="mini-timeline">
                <i />
                <i />
                <i />
                <b />
              </div>
            </div>
          </section>
          <div className="project-toolbar">
            <h2>
              Projelerin <span>{projects.length}</span>
            </h2>
            <label>
              <Search size={15} />
              <input
                placeholder="Proje ara"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="project-grid">
            <button
              className="new-project"
              disabled={busy}
              onClick={() => create()}
            >
              <span>
                <Plus size={27} />
              </span>
              <b>Yeni bir hikâye</b>
              <small>Boş bir zaman çizelgesiyle başla</small>
            </button>
            {projects
              .filter((p) =>
                p.name
                  .toLocaleLowerCase("tr-TR")
                  .includes(query.toLocaleLowerCase("tr-TR")),
              )
              .map((p) => (
                <button
                  className="project-card"
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                >
                  <div className="project-cover">
                    {p.poster ? (
                      <img src={p.poster} alt="" />
                    ) : (
                      <div className="cover-empty">
                        <Film size={32} />
                        <span>İLK KARESİNİ BEKLİYOR</span>
                      </div>
                    )}
                    <span>{clock(p.duration)}</span>
                  </div>
                  <div className="project-meta">
                    <h3>{p.name}</h3>
                    <p>
                      {date(p.updated)} <i /> {p.clips} klip{" "}
                      <span>v{p.revision}</span>
                    </p>
                  </div>
                </button>
              ))}
          </div>
          <footer>
            <span>FRAMELAB / BİR FİKRİN İLK KARESİ</span>
            <span>Kaynak video ve müzik hakları sana ait olmalı.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
