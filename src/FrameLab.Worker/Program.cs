using FrameLab;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

var config = new ConfigurationBuilder().AddEnvironmentVariables().AddCommandLine(args).Build();
var owner = Guid.NewGuid().ToString("N");
var data = Path.GetFullPath(config["DataPath"] ?? ".runtime");
var store = new ObjectStore(config);
var tools = new MediaTools(config);
using var stop = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    stop.Cancel();
};
async Task Seen()
{
    await using var db = FrameDb.Open(config);
    var row = await db.Workers.FindAsync(owner);
    if (row == null)
        db.Workers.Add(new() { Id = owner, Seen = DateTime.UtcNow.Ticks });
    else
        row.Seen = DateTime.UtcNow.Ticks;
    await db.SaveChangesAsync();
}
async Task<Job?> Claim()
{
    await using var db = FrameDb.Open(config);
    var now = DateTime.UtcNow.Ticks;
    var candidate = await db
        .Jobs.AsNoTracking()
        .Where(j =>
            j.State == "queued"
            || (j.State == "running" || j.State == "cancel_requested") && j.LeaseUntil < now
        )
        .OrderBy(j => j.Created)
        .FirstOrDefaultAsync();
    if (candidate == null)
        return null;
    if (candidate.State == "cancel_requested")
    {
        await db
            .Jobs.Where(j =>
                j.Id == candidate.Id && j.State == "cancel_requested" && j.LeaseUntil < now
            )
            .ExecuteUpdateAsync(s =>
                s.SetProperty(j => j.State, "cancelled").SetProperty(j => j.Stage, "İptal edildi")
            );
        return null;
    }
    var leaseUntil = DateTime.UtcNow.AddSeconds(20).Ticks;
    var count = await db
        .Jobs.Where(j =>
            j.Id == candidate.Id
            && (j.State == "queued" || j.State == "running" && j.LeaseUntil < now)
        )
        .ExecuteUpdateAsync(s =>
            s.SetProperty(j => j.State, "running")
                .SetProperty(j => j.LeaseOwner, owner)
                .SetProperty(j => j.LeaseUntil, leaseUntil)
                .SetProperty(j => j.Progress, 0)
                .SetProperty(j => j.Stage, "Başlıyor")
                .SetProperty(j => j.Attempt, j => j.Attempt + 1)
        );
    return count == 1 ? await db.Jobs.AsNoTracking().SingleAsync(j => j.Id == candidate.Id) : null;
}
async Task Work(Job job)
{
    using var cancel = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
    using var heartbeatStop = new CancellationTokenSource();
    var progress = 0d;
    var stage = "Başlıyor";
    var sync = new object();
    void Report(double n, string text)
    {
        lock (sync)
        {
            progress = Math.Max(progress, Math.Clamp(n, 0, .99));
            stage = text;
        }
    }
    var heartbeat = Task.Run(async () =>
    {
        while (!heartbeatStop.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(1500, heartbeatStop.Token);
                await using var db = FrameDb.Open(config);
                var current = await db.Jobs.AsNoTracking().SingleAsync(j => j.Id == job.Id);
                if (current.LeaseOwner != owner || current.State != "running")
                {
                    cancel.Cancel();
                    return;
                }
                double p;
                string s;
                lock (sync)
                {
                    p = progress;
                    s = stage;
                }
                var now = DateTime.UtcNow.Ticks;
                var renewedUntil = DateTime.UtcNow.AddSeconds(20).Ticks;
                var count = await db
                    .Jobs.Where(j =>
                        j.Id == job.Id
                        && j.LeaseOwner == owner
                        && j.State == "running"
                        && j.LeaseUntil > now
                    )
                    .ExecuteUpdateAsync(v =>
                        v.SetProperty(j => j.LeaseUntil, renewedUntil)
                            .SetProperty(j => j.Progress, p)
                            .SetProperty(j => j.Stage, s)
                    );
                if (count != 1)
                {
                    cancel.Cancel();
                    return;
                }
                await Seen();
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
                cancel.Cancel();
                return;
            }
        }
    });
    var directory = Path.Combine(data, "work", job.Id, Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(directory);
    try
    {
        await using var db = FrameDb.Open(config);
        var assets = new List<Asset>();
        Project? project = null;
        string output = "";
        if (job.Kind == "ingest")
        {
            var asset = await db.Assets.SingleAsync(a =>
                a.Id == job.Payload && a.ProjectId == job.ProjectId
            );
            await tools.Ingest(asset, store, directory, cancel.Token, Report);
            assets.Add(asset);
        }
        else if (job.Kind == "demo")
        {
            project = await db.Projects.SingleAsync(p => p.Id == job.ProjectId);
            for (var i = 0; i < 2; i++)
            {
                Report(i * .45, "Örnek medya oluşturuluyor");
                var source = await tools.Sample(i, directory, cancel.Token);
                var asset = new Asset
                {
                    ProjectId = job.ProjectId,
                    Name = $"Form — Scene 0{i + 1}.mp4",
                    Bytes = new FileInfo(source).Length,
                };
                asset.SourceKey = "sources/" + asset.Id + ".bin";
                await store.Put(asset.SourceKey, source, cancel.Token);
                await tools.Ingest(
                    asset,
                    store,
                    directory,
                    cancel.Token,
                    (n, s) => Report(i * .45 + n * .4, s)
                );
                assets.Add(asset);
                db.Assets.Add(asset);
            }
            await db.Entry(project).ReloadAsync(cancel.Token);
            if (project.Revision == 1 && Wire.Read<EditDocument>(project.Document).Clips.Count == 0)
            {
                var doc = new EditDocument
                {
                    Clips = assets
                        .Select(
                            (a, i) =>
                                new Clip
                                {
                                    AssetId = a.Id,
                                    In = 0,
                                    Out = 6,
                                    Title = i == 0 ? "Bir fikrin ilk karesi." : "Hikâyene yer aç.",
                                    TitlePosition = "bottom",
                                    Transition = "fade",
                                }
                        )
                        .ToList(),
                };
                project.Document = Wire.Write(doc);
                project.Revision++;
                project.Updated = DateTime.UtcNow.Ticks;
                db.Versions.Add(
                    new()
                    {
                        ProjectId = project.Id,
                        Revision = project.Revision,
                        Name = project.Name,
                        Document = project.Document,
                    }
                );
            }
        }
        else if (job.Kind == "render")
        {
            var input = Wire.Read<RenderInput>(job.Payload);
            await Security.Validate(input.Document, job.ProjectId, db, true);
            assets = await db
                .Assets.Where(a => a.ProjectId == job.ProjectId && a.State == "ready")
                .ToListAsync();
            var path = await tools.Render(input, assets, store, directory, cancel.Token, Report);
            output = "renders/" + job.Id + "/" + Path.GetFileName(directory) + ".mp4";
            await store.Put(output, path, cancel.Token);
        }
        else
            throw new InvalidOperationException("Bilinmeyen iş türü.");
        cancel.Token.ThrowIfCancellationRequested();
        await using var tx = await db.Database.BeginTransactionAsync();
        var completedAt = DateTime.UtcNow.Ticks;
        var updated = await db
            .Jobs.Where(j =>
                j.Id == job.Id
                && j.LeaseOwner == owner
                && j.State == "running"
                && j.LeaseUntil > completedAt
            )
            .ExecuteUpdateAsync(s =>
                s.SetProperty(j => j.State, "completed")
                    .SetProperty(j => j.Progress, 1)
                    .SetProperty(j => j.Stage, "Tamamlandı")
                    .SetProperty(j => j.OutputKey, output)
                    .SetProperty(j => j.LeaseUntil, 0)
            );
        if (updated != 1)
            throw new OperationCanceledException();
        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }
    catch (Exception e)
    {
        Console.Error.WriteLine($"Job {job.Id}: {e.Message}");
        await using var db = FrameDb.Open(config);
        var cancelled = e is OperationCanceledException;
        var failedAt = DateTime.UtcNow.Ticks;
        var changed = await db
            .Jobs.Where(j =>
                j.Id == job.Id
                && j.LeaseOwner == owner
                && j.LeaseUntil > failedAt
                && (j.State == "running" || j.State == "cancel_requested")
            )
            .ExecuteUpdateAsync(s =>
                s.SetProperty(j => j.State, cancelled ? "cancelled" : "failed")
                    .SetProperty(j => j.Stage, cancelled ? "İptal edildi" : "İşlem başarısız")
                    .SetProperty(
                        j => j.Error,
                        cancelled ? ""
                            : e.Message.Length > 300 ? "Medya işlemi başarısız."
                            : e.Message
                    )
                    .SetProperty(j => j.LeaseUntil, 0)
            );
        if (changed == 1 && job.Kind == "ingest")
            await db
                .Assets.Where(a => a.Id == job.Payload && a.State == "queued")
                .ExecuteUpdateAsync(s =>
                    s.SetProperty(a => a.State, "failed")
                        .SetProperty(
                            a => a.Error,
                            "Dosya işlenemedi. Desteklenen bir video veya ses dosyası yükleyin."
                        )
                );
    }
    finally
    {
        heartbeatStop.Cancel();
        await heartbeat;
    }
}
Console.WriteLine("FrameLab worker ready");
while (!stop.IsCancellationRequested)
{
    try
    {
        await Seen();
        var job = await Claim();
        if (job != null)
            await Work(job);
        else
            await Task.Delay(1000, stop.Token);
    }
    catch (OperationCanceledException)
    {
        break;
    }
    catch (Exception e)
    {
        Console.Error.WriteLine(e.Message);
        try
        {
            await Task.Delay(2000, stop.Token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}
