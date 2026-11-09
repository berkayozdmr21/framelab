using System.Security.Cryptography;
using System.Threading.RateLimiting;
using FrameLab;
using Microsoft.EntityFrameworkCore;

var b = WebApplication.CreateBuilder(args);
b.Services.AddScoped(_ => FrameDb.Open(b.Configuration));
b.Services.AddSingleton<ObjectStore>();
b.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.AddPolicy(
        "login",
        c =>
            RateLimitPartition.GetFixedWindowLimiter(
                c.Connection.RemoteIpAddress?.ToString() ?? "local",
                _ => new() { PermitLimit = 20, Window = TimeSpan.FromMinutes(1) }
            )
    );
});
b.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 5 * 1024 * 1024);
var app = b.Build();
var data = Path.GetFullPath(b.Configuration["DataPath"] ?? ".runtime");
Directory.CreateDirectory(Path.Combine(data, "uploads"));
var uploadGate = new SemaphoreSlim(1, 1);
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<FrameDb>();
    await db.Database.EnsureCreatedAsync();
    if (!await db.Accounts.AnyAsync())
    {
        var password =
            b.Configuration["AdminPassword"]
            ?? (
                app.Environment.IsDevelopment()
                    ? "Framelab2026!"
                    : throw new InvalidOperationException(
                        "Production requires AdminPassword on first initialization."
                    )
            );
        db.Accounts.Add(
            new()
            {
                Username = "berkay",
                Name = "Berkay Özdemir",
                PasswordHash = Security.Password(password),
                Admin = true,
            }
        );
        if (app.Environment.IsDevelopment())
            db.Accounts.Add(
                new()
                {
                    Username = "deniz",
                    Name = "Deniz Aksoy",
                    PasswordHash = Security.Password("Framelab2026!"),
                }
            );
        await db.SaveChangesAsync();
    }
}
app.Use(
    async (c, next) =>
    {
        try
        {
            c.Response.Headers["Cache-Control"] = "no-store";
            c.Response.Headers["X-Content-Type-Options"] = "nosniff";
            if (
                c.Request.Method != "GET"
                && c.Request.Path.StartsWithSegments("/api")
                && c.Request.Headers.Origin.Count > 0
                && c.Request.Headers.Origin.ToString()
                    != (b.Configuration["PublicOrigin"] ?? "http://127.0.0.1:9260")
            )
                throw new Fault(403, "Kaynak adresi kabul edilmedi.");
            await next();
        }
        catch (Exception e)
        {
            if (c.Response.HasStarted)
                throw;
            var status = e switch
            {
                Fault f => f.Status,
                DbUpdateConcurrencyException => 409,
                System.Text.Json.JsonException => 400,
                BadHttpRequestException x => x.StatusCode,
                _ => 500,
            };
            c.Response.StatusCode = status;
            if (status == 500)
                app.Logger.LogError(e, "API request failed");
            await c.Response.WriteAsJsonAsync(
                new { error = status == 500 ? "Sunucu hatası." : e.Message }
            );
        }
    }
);
app.UseRateLimiter();
app.MapGet("/health", () => new { status = "ok" });
app.MapGet("/api/auth-config", () => new { development = app.Environment.IsDevelopment() });
app.MapPost(
        "/api/login",
        async (Login input, HttpContext c, FrameDb db) =>
        {
            if (
                string.IsNullOrEmpty(input.Username)
                || string.IsNullOrEmpty(input.Password)
                || input.Password.Length > 200
            )
                throw new Fault(400, "Giriş alanları gerekli.");
            var user = await db.Accounts.SingleOrDefaultAsync(a =>
                a.Username == input.Username.ToLowerInvariant()
            );
            if (user == null || !Security.Check(input.Password, user.PasswordHash))
                throw new Fault(401, "Kullanıcı adı veya şifre hatalı.");
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            db.Sessions.Add(
                new()
                {
                    Id = Security.Hash(token),
                    AccountId = user.Id,
                    Until = DateTime.UtcNow.AddHours(12).Ticks,
                }
            );
            await db.SaveChangesAsync();
            c.Response.Cookies.Append(
                "framelab-session",
                token,
                new()
                {
                    HttpOnly = true,
                    SameSite = SameSiteMode.Strict,
                    Secure = c.Request.IsHttps,
                    MaxAge = TimeSpan.FromHours(12),
                }
            );
            return Results.Ok(
                new
                {
                    user = new
                    {
                        user.Id,
                        user.Name,
                        user.Username,
                        user.Admin,
                    },
                    token,
                }
            );
        }
    )
    .RequireRateLimiting("login");
app.MapGet(
    "/api/me",
    async (HttpContext c, FrameDb db) =>
    {
        var u = await Security.User(c, db);
        return Results.Ok(
            new
            {
                u.Id,
                u.Name,
                u.Username,
                u.Admin,
            }
        );
    }
);
app.MapPost(
    "/api/logout",
    async (HttpContext c, FrameDb db) =>
    {
        var token =
            c.Request.Cookies["framelab-session"]
            ?? c.Request.Headers.Authorization.ToString().Replace("Bearer ", "");
        if (token.Length > 0)
            await db.Sessions.Where(s => s.Id == Security.Hash(token)).ExecuteDeleteAsync();
        c.Response.Cookies.Delete("framelab-session");
        return Results.NoContent();
    }
);
app.MapPost(
    "/api/users",
    async (NewUser input, HttpContext c, FrameDb db) =>
    {
        var u = await Security.User(c, db);
        if (!u.Admin)
            throw new Fault(403, "Yönetici gerekli.");
        if (
            string.IsNullOrWhiteSpace(input.Name)
            || input.Name.Length > 80
            || string.IsNullOrWhiteSpace(input.Username)
            || input.Username.Length > 30
            || input.Username.Any(x => !char.IsAsciiLetterOrDigit(x))
            || input.Password == null
            || input.Password.Length is < 12 or > 200
        )
            throw new Fault(400, "Kullanıcı bilgileri geçersiz; parola en az 12 karakter olmalı.");
        if (await db.Accounts.AnyAsync(a => a.Username == input.Username.ToLowerInvariant()))
            throw new Fault(409, "Kullanıcı adı alınmış.");
        var account = new Account
        {
            Name = input.Name,
            Username = input.Username.ToLowerInvariant(),
            PasswordHash = Security.Password(input.Password),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return Results.Ok(
            new
            {
                account.Id,
                account.Name,
                account.Username,
            }
        );
    }
);
app.MapGet(
    "/api/projects",
    async (HttpContext c, FrameDb db) =>
    {
        var u = await Security.User(c, db);
        var projects = await db
            .Projects.Where(p =>
                p.OwnerId == u.Id || db.Members.Any(m => m.ProjectId == p.Id && m.AccountId == u.Id)
            )
            .OrderByDescending(p => p.Updated)
            .ToListAsync();
        var list = new List<object>();
        foreach (var p in projects)
        {
            var asset = await db.Assets.FirstOrDefaultAsync(a =>
                a.ProjectId == p.Id && a.State == "ready" && a.Kind == "video"
            );
            var doc = Wire.Read<EditDocument>(p.Document);
            list.Add(
                new
                {
                    p.Id,
                    p.Name,
                    p.Revision,
                    p.Updated,
                    clips = doc.Clips.Count,
                    duration = doc.Clips.Sum(x => x.Out - x.In),
                    format = doc.Format,
                    poster = asset?.PosterKey.Length > 0
                        ? "/api/assets/" + asset.Id + "/poster"
                        : null,
                }
            );
        }
        return Results.Ok(list);
    }
);
async Task<Project> Create(string name, Account u, FrameDb db)
{
    if (string.IsNullOrWhiteSpace(name) || name.Length > 80)
        throw new Fault(400, "Proje adı 1–80 karakter olmalı.");
    if (await db.Projects.CountAsync(p => p.OwnerId == u.Id) >= 12)
        throw new Fault(409, "En fazla 12 proje oluşturulabilir.");
    var p = new Project
    {
        OwnerId = u.Id,
        Name = name.Trim(),
        Document = Wire.Write(new EditDocument()),
    };
    db.Projects.Add(p);
    db.Versions.Add(
        new()
        {
            ProjectId = p.Id,
            Revision = 1,
            Name = p.Name,
            Document = p.Document,
        }
    );
    await db.SaveChangesAsync();
    return p;
}
app.MapPost(
    "/api/projects",
    async (NewProject input, HttpContext c, FrameDb db) =>
    {
        var p = await Create(input.Name, await Security.User(c, db), db);
        return Results.Ok(
            new
            {
                p.Id,
                p.Name,
                p.Revision,
            }
        );
    }
);
app.MapPost(
    "/api/projects/demo",
    async (HttpContext c, FrameDb db) =>
    {
        var p = await Create("Form / Motion study", await Security.User(c, db), db);
        db.Jobs.Add(
            new()
            {
                ProjectId = p.Id,
                Key = "demo",
                Kind = "demo",
            }
        );
        await db.SaveChangesAsync();
        return Results.Ok(
            new
            {
                p.Id,
                p.Name,
                p.Revision,
            }
        );
    }
);
object AssetView(Asset a) =>
    new
    {
        a.Id,
        a.Name,
        a.Kind,
        a.State,
        a.Duration,
        a.Width,
        a.Height,
        a.HasAudio,
        a.Bytes,
        a.Error,
        proxy = a.State == "ready" ? "/api/assets/" + a.Id + "/proxy" : null,
        poster = a.PosterKey.Length > 0 ? "/api/assets/" + a.Id + "/poster" : null,
        wave = a.WaveKey.Length > 0 ? "/api/assets/" + a.Id + "/wave" : null,
    };
object JobView(Job j) =>
    new
    {
        j.Id,
        j.Kind,
        assetId = j.Kind == "ingest" ? j.Payload : null,
        j.State,
        j.Progress,
        j.Stage,
        j.Error,
        j.Attempt,
        j.Created,
        download = j.State == "completed" && j.Kind == "render"
            ? "/api/jobs/" + j.Id + "/download"
            : null,
    };
app.MapGet(
    "/api/projects/{id}",
    async (string id, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db);
        var assets = await db.Assets.Where(a => a.ProjectId == id).ToListAsync();
        var jobs = await db
            .Jobs.Where(j => j.ProjectId == id)
            .OrderByDescending(j => j.Created)
            .Take(30)
            .ToListAsync();
        return Results.Ok(
            new
            {
                project = new
                {
                    p.Id,
                    p.Name,
                    p.Revision,
                    p.Updated,
                    document = Wire.Read<EditDocument>(p.Document),
                },
                role,
                assets = assets.Select(AssetView),
                jobs = jobs.Select(JobView),
                comments = await db
                    .Comments.Where(x => x.ProjectId == id)
                    .OrderByDescending(x => x.Created)
                    .Take(100)
                    .ToListAsync(),
                versions = await db
                    .Versions.Where(x => x.ProjectId == id)
                    .OrderByDescending(x => x.Revision)
                    .Take(20)
                    .Select(v => new
                    {
                        v.Revision,
                        v.Name,
                        v.Created,
                    })
                    .ToListAsync(),
            }
        );
    }
);
app.MapPut(
    "/api/projects/{id}",
    async (string id, SaveProject input, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db, true);
        if (p.Revision != input.Revision)
            throw new Fault(
                409,
                "Proje başka bir düzenleyici tarafından değiştirildi. Taslağını koruyup güncel sürümü yükle."
            );
        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 80)
            throw new Fault(400, "Proje adı geçersiz.");
        await Security.Validate(input.Document, id, db);
        p.Name = input.Name.Trim();
        p.Document = Wire.Write(input.Document);
        p.Revision++;
        p.Updated = DateTime.UtcNow.Ticks;
        db.Versions.Add(
            new()
            {
                ProjectId = id,
                Revision = p.Revision,
                Name = p.Name,
                Document = p.Document,
            }
        );
        await db.SaveChangesAsync();
        return Results.Ok(
            new
            {
                p.Id,
                p.Name,
                p.Revision,
                document = input.Document,
            }
        );
    }
);
app.MapPost(
    "/api/projects/{id}/restore/{revision:long}",
    async (string id, long revision, RestoreVersion input, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db, true);
        if (p.Revision != input.Revision)
            throw new Fault(409, "Proje sürümü değişmiş.");
        var old =
            await db.Versions.FindAsync(id, revision) ?? throw new Fault(404, "Sürüm bulunamadı.");
        await Security.Validate(Wire.Read<EditDocument>(old.Document), id, db);
        p.Name = old.Name;
        p.Document = old.Document;
        p.Revision++;
        p.Updated = DateTime.UtcNow.Ticks;
        db.Versions.Add(
            new()
            {
                ProjectId = id,
                Revision = p.Revision,
                Name = p.Name,
                Document = p.Document,
            }
        );
        await db.SaveChangesAsync();
        return Results.Ok(new { p.Id, p.Revision });
    }
);
app.MapPost(
    "/api/projects/{id}/members",
    async (string id, Share input, HttpContext c, FrameDb db) =>
    {
        await Security.Access(id, c, db, owner: true);
        if (!new[] { "viewer", "editor" }.Contains(input.Role))
            throw new Fault(400, "Rol geçersiz.");
        var account =
            await db.Accounts.SingleOrDefaultAsync(a => a.Username == input.Username)
            ?? throw new Fault(404, "Kullanıcı bulunamadı.");
        var p = await db.Projects.FindAsync(id);
        if (p!.OwnerId == account.Id)
            throw new Fault(400, "Proje sahibinin rolü değiştirilemez.");
        var m = await db.Members.FindAsync(id, account.Id);
        if (m == null)
            db.Members.Add(
                new()
                {
                    ProjectId = id,
                    AccountId = account.Id,
                    Role = input.Role,
                }
            );
        else
            m.Role = input.Role;
        await db.SaveChangesAsync();
        return Results.NoContent();
    }
);
app.MapDelete(
    "/api/projects/{id}/members/{accountId}",
    async (string id, string accountId, HttpContext c, FrameDb db) =>
    {
        await Security.Access(id, c, db, owner: true);
        await db
            .Members.Where(m => m.ProjectId == id && m.AccountId == accountId)
            .ExecuteDeleteAsync();
        return Results.NoContent();
    }
);
app.MapGet(
    "/api/projects/{id}/members",
    async (string id, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db);
        var members = await db
            .Members.Where(m => m.ProjectId == id)
            .Join(
                db.Accounts,
                m => m.AccountId,
                a => a.Id,
                (m, a) =>
                    new
                    {
                        a.Id,
                        a.Username,
                        a.Name,
                        m.Role,
                    }
            )
            .ToListAsync();
        var owner = await db.Accounts.FindAsync(p.OwnerId);
        return Results.Ok(
            new
            {
                owner = new
                {
                    owner!.Id,
                    owner.Name,
                    owner.Username,
                },
                members,
            }
        );
    }
);
app.MapPost(
    "/api/projects/{id}/comments",
    async (string id, AddComment input, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db);
        if (
            string.IsNullOrWhiteSpace(input.Text)
            || input.Text.Length > 1000
            || !double.IsFinite(input.At)
            || input.At is < 0 or > 180
        )
            throw new Fault(400, "Yorum alanları geçersiz.");
        if (await db.Comments.CountAsync(x => x.ProjectId == id) >= 500)
            throw new Fault(409, "Yorum sınırına ulaşıldı.");
        var comment = new Comment
        {
            ProjectId = id,
            AuthorId = u.Id,
            Author = u.Name,
            Text = input.Text.Trim(),
            At = input.At,
        };
        db.Comments.Add(comment);
        await db.SaveChangesAsync();
        return Results.Ok(comment);
    }
);
app.MapPost(
    "/api/projects/{id}/uploads",
    async (string id, StartUpload input, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db, true);
        var ext = Path.GetExtension(input.Name ?? "").ToLowerInvariant();
        if (
            input.Name == null
            || input.Name.Length > 160
            || !new[] { ".mp4", ".mov", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".flac" }.Contains(
                ext
            )
            || input.Total is < 1 or > 209715200
            || input.Hash == null
            || input.Hash.Length != 64
            || input.Hash.Any(x => !"0123456789abcdef".Contains(x))
            || string.IsNullOrEmpty(input.Key)
            || input.Key.Length > 100
        )
            throw new Fault(400, "MP4/MOV/WebM veya ses dosyası, en fazla 200 MB seçin.");
        var prior = await db.Uploads.SingleOrDefaultAsync(x =>
            x.ProjectId == id && x.AccountId == u.Id && x.Key == input.Key
        );
        if (prior != null)
        {
            if (prior.Hash != input.Hash || prior.Name != input.Name || prior.Total != input.Total)
                throw new Fault(409, "Yükleme anahtarı farklı dosyaya ait.");
            return Results.Ok(prior);
        }
        if (
            await db.Assets.CountAsync(a => a.ProjectId == id) >= 30
            || ((await db.Uploads.SumAsync(x => (long?)x.Total) ?? 0) + input.Total)
                > 2L * 1024 * 1024 * 1024
        )
            throw new Fault(409, "Medya kotası dolu.");
        var upload = new Upload
        {
            ProjectId = id,
            AccountId = u.Id,
            Key = input.Key,
            Name = input.Name,
            Hash = input.Hash,
            Total = input.Total,
        };
        db.Uploads.Add(upload);
        await db.SaveChangesAsync();
        return Results.Ok(upload);
    }
);
async Task<Upload> OwnUpload(string id, HttpContext c, FrameDb db)
{
    var upload = await db.Uploads.FindAsync(id) ?? throw new Fault(404, "Yükleme bulunamadı.");
    var (_, u, _) = await Security.Access(upload.ProjectId, c, db, true);
    if (upload.AccountId != u.Id)
        throw new Fault(403, "Yükleme başka kullanıcıya ait.");
    return upload;
}
app.MapGet(
    "/api/uploads/{id}",
    async (string id, HttpContext c, FrameDb db) => Results.Ok(await OwnUpload(id, c, db))
);
app.MapPut(
    "/api/uploads/{id}",
    async (string id, long offset, HttpContext c, FrameDb db) =>
    {
        var upload = await OwnUpload(id, c, db);
        if (upload.AssetId != null)
            throw new Fault(409, "Yükleme zaten tamamlandı.");
        using var ms = new MemoryStream();
        await c.Request.Body.CopyToAsync(ms, c.RequestAborted);
        if (ms.Length is < 1 or > 4194304 || offset < 0 || offset + ms.Length > upload.Total)
            throw new Fault(400, "Parça boyutu veya konumu geçersiz.");
        await uploadGate.WaitAsync(c.RequestAborted);
        try
        {
            await db.Entry(upload).ReloadAsync();
            var path = Path.Combine(data, "uploads", upload.Id + ".part");
            await using var file = new FileStream(
                path,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            );
            if (file.Length < upload.Received)
                throw new Fault(409, "Yükleme dosyası eksik; yeni yükleme başlatın.");
            if (file.Length > upload.Received)
                file.SetLength(upload.Received);
            var bytes = ms.ToArray();
            if (offset < upload.Received)
            {
                if (offset + bytes.Length > upload.Received)
                    throw new Fault(409, "Parça sınırı değişmiş.");
                file.Position = offset;
                var existing = new byte[bytes.Length];
                await file.ReadExactlyAsync(existing, c.RequestAborted);
                if (!SHA256.HashData(existing).SequenceEqual(SHA256.HashData(bytes)))
                    throw new Fault(409, "Önceki parça farklı içerikle yeniden gönderildi.");
                return Results.Ok(new { upload.Received });
            }
            if (offset != upload.Received)
                throw new Fault(409, "Yükleme konumu değişmiş.");
            file.Position = offset;
            await file.WriteAsync(bytes, c.RequestAborted);
            file.Flush(true);
            upload.Received += bytes.Length;
            await db.SaveChangesAsync();
            return Results.Ok(new { upload.Received });
        }
        finally
        {
            uploadGate.Release();
        }
    }
);
app.MapPost(
    "/api/uploads/{id}/complete",
    async (string id, HttpContext c, FrameDb db, ObjectStore store) =>
    {
        var upload = await OwnUpload(id, c, db);
        await uploadGate.WaitAsync(c.RequestAborted);
        try
        {
            await db.Entry(upload).ReloadAsync();
            if (upload.AssetId != null)
                return Results.Ok(new { assetId = upload.AssetId });
            if (upload.Received != upload.Total)
                throw new Fault(409, "Dosyanın tüm parçaları yüklenmedi.");
            var path = Path.Combine(data, "uploads", id + ".part");
            if (await ObjectStore.Hash(path) != upload.Hash)
                throw new Fault(422, "Dosya SHA-256 değeri eşleşmiyor.");
            var asset = new Asset
            {
                ProjectId = upload.ProjectId,
                Name = upload.Name,
                Bytes = upload.Total,
            };
            asset.SourceKey = "sources/" + asset.Id + ".bin";
            await store.Put(asset.SourceKey, path, c.RequestAborted);
            db.Assets.Add(asset);
            db.Jobs.Add(
                new()
                {
                    ProjectId = asset.ProjectId,
                    Key = "ingest-" + asset.Id,
                    Kind = "ingest",
                    Payload = asset.Id,
                }
            );
            upload.AssetId = asset.Id;
            await db.SaveChangesAsync();
            return Results.Ok(new { assetId = asset.Id });
        }
        finally
        {
            uploadGate.Release();
        }
    }
);
app.MapGet(
    "/api/assets/{id}/{kind}",
    async (string id, string kind, HttpContext c, FrameDb db, ObjectStore store) =>
    {
        var asset = await db.Assets.FindAsync(id) ?? throw new Fault(404, "Medya bulunamadı.");
        await Security.Access(asset.ProjectId, c, db);
        var key = kind switch
        {
            "proxy" => asset.ProxyKey,
            "poster" => asset.PosterKey,
            "wave" => asset.WaveKey,
            _ => "",
        };
        if (asset.State != "ready" || key.Length == 0)
            throw new Fault(404, "Önizleme hazır değil.");
        var type =
            key.EndsWith(".png") ? "image/png"
            : key.EndsWith(".jpg") ? "image/jpeg"
            : key.EndsWith(".m4a") ? "audio/mp4"
            : "video/mp4";
        return Results.File(
            await store.Get(key, c.RequestAborted),
            type,
            enableRangeProcessing: true
        );
    }
);
app.MapPost(
    "/api/projects/{id}/renders",
    async (string id, StartRender input, HttpContext c, FrameDb db) =>
    {
        var (p, u, role) = await Security.Access(id, c, db, true);
        if (
            input.Key == null
            || input.Key.Length is < 1 or > 100
            || !new[] { "720p", "1080p" }.Contains(input.Preset)
        )
            throw new Fault(400, "Render ayarı geçersiz.");
        var doc = Wire.Read<EditDocument>(p.Document);
        var payload = Wire.Write(new RenderInput(doc, input.Preset, input.Revision));
        var prior = await db.Jobs.SingleOrDefaultAsync(j =>
            j.ProjectId == id && j.Key == input.Key
        );
        if (prior != null)
        {
            if (prior.Kind != "render" || prior.Payload != payload)
                throw new Fault(409, "Render anahtarı farklı ayarla kullanılmış.");
            return Results.Ok(JobView(prior));
        }
        if (input.Revision != p.Revision)
            throw new Fault(409, "Önce güncel taslağı kaydet.");
        await Security.Validate(doc, id, db, true);
        if (
            await db.Jobs.AnyAsync(j =>
                j.ProjectId == id
                && (j.State == "queued" || j.State == "running" || j.State == "cancel_requested")
            )
        )
            throw new Fault(409, "Projenin önceki medya işlemini bekle.");
        var job = new Job
        {
            ProjectId = id,
            Key = input.Key,
            Payload = payload,
        };
        db.Jobs.Add(job);
        await db.SaveChangesAsync();
        return Results.Ok(JobView(job));
    }
);
app.MapGet(
    "/api/jobs/{id}",
    async (string id, HttpContext c, FrameDb db) =>
    {
        var job = await db.Jobs.FindAsync(id) ?? throw new Fault(404, "İş bulunamadı.");
        await Security.Access(job.ProjectId, c, db);
        return Results.Ok(JobView(job));
    }
);
app.MapPost(
    "/api/jobs/{id}/cancel",
    async (string id, HttpContext c, FrameDb db) =>
    {
        var job = await db.Jobs.FindAsync(id) ?? throw new Fault(404, "İş bulunamadı.");
        await Security.Access(job.ProjectId, c, db, true);
        if (job.Kind != "render")
            throw new Fault(400, "Yalnızca çıktı işleri iptal edilebilir.");
        await db
            .Jobs.Where(j => j.Id == id && j.State == "queued")
            .ExecuteUpdateAsync(s =>
                s.SetProperty(j => j.State, "cancelled").SetProperty(j => j.Stage, "İptal edildi")
            );
        await db
            .Jobs.Where(j => j.Id == id && j.State == "running")
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.State, "cancel_requested"));
        return Results.NoContent();
    }
);
app.MapPost(
    "/api/jobs/{id}/retry",
    async (string id, HttpContext c, FrameDb db) =>
    {
        var old = await db.Jobs.FindAsync(id) ?? throw new Fault(404, "İş bulunamadı.");
        await Security.Access(old.ProjectId, c, db, true);
        if (old.State is not ("failed" or "cancelled"))
            throw new Fault(409, "İş henüz tamamlanmadı.");
        if (old.Kind == "ingest")
        {
            var asset = await db.Assets.FindAsync(old.Payload);
            if (asset != null)
            {
                asset.State = "queued";
                asset.Error = "";
            }
        }
        if (
            await db.Jobs.AnyAsync(j =>
                j.ProjectId == old.ProjectId
                && (j.State == "queued" || j.State == "running" || j.State == "cancel_requested")
            )
        )
            throw new Fault(409, "Önceki işi bekleyin.");
        var job = new Job
        {
            ProjectId = old.ProjectId,
            Kind = old.Kind,
            Payload = old.Payload,
            Key = "retry-" + Guid.NewGuid().ToString("N"),
        };
        db.Jobs.Add(job);
        await db.SaveChangesAsync();
        return Results.Ok(JobView(job));
    }
);
app.MapGet(
    "/api/jobs/{id}/download",
    async (string id, HttpContext c, FrameDb db, ObjectStore store) =>
    {
        var job = await db.Jobs.FindAsync(id) ?? throw new Fault(404, "İş bulunamadı.");
        await Security.Access(job.ProjectId, c, db);
        if (job.State != "completed" || job.OutputKey.Length == 0)
            throw new Fault(409, "Çıktı hazır değil.");
        return Results.File(
            await store.Get(job.OutputKey, c.RequestAborted),
            "video/mp4",
            "framelab-" + id[..8] + ".mp4",
            enableRangeProcessing: true
        );
    }
);
app.MapGet(
    "/api/system",
    async (HttpContext c, FrameDb db) =>
    {
        await Security.User(c, db);
        var cutoff = DateTime.UtcNow.AddSeconds(-20).Ticks;
        return Results.Ok(
            new
            {
                workers = await db.Workers.CountAsync(w => w.Seen > cutoff),
                queue = await db.Jobs.CountAsync(j => j.State == "queued"),
            }
        );
    }
);
app.Run();

record Login(string Username, string Password);

record NewUser(string Username, string Name, string Password);

record NewProject(string Name);

record SaveProject(string Name, long Revision, EditDocument Document);

record RestoreVersion(long Revision);

record Share(string Username, string Role);

record AddComment(string Text, double At);

record StartUpload(string Name, long Total, string Hash, string Key);

record StartRender(string Key, long Revision, string Preset);
