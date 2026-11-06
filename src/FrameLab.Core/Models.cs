using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace FrameLab;

public class FrameDb(DbContextOptions<FrameDb> options) : DbContext(options)
{
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Member> Members => Set<Member>();
    public DbSet<Asset> Assets => Set<Asset>();
    public DbSet<Upload> Uploads => Set<Upload>();
    public DbSet<Job> Jobs => Set<Job>();
    public DbSet<ProjectVersion> Versions => Set<ProjectVersion>();
    public DbSet<Comment> Comments => Set<Comment>();
    public DbSet<WorkerStatus> Workers => Set<WorkerStatus>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Account>().HasIndex(x => x.Username).IsUnique();
        b.Entity<Member>().HasKey(x => new { x.ProjectId, x.AccountId });
        b.Entity<ProjectVersion>().HasKey(x => new { x.ProjectId, x.Revision });
        b.Entity<Project>().Property(x => x.Revision).IsConcurrencyToken();
        b.Entity<Upload>()
            .HasIndex(x => new
            {
                x.ProjectId,
                x.AccountId,
                x.Key,
            })
            .IsUnique();
        b.Entity<Job>().HasIndex(x => new { x.ProjectId, x.Key }).IsUnique();
        b.Entity<Job>().HasIndex(x => new { x.State, x.LeaseUntil });
    }

    public static FrameDb Open(IConfiguration c)
    {
        var o = new DbContextOptionsBuilder<FrameDb>();
        if (c["DatabaseProvider"] == "Postgres")
            o.UseNpgsql(c.GetConnectionString("Default"));
        else
        {
            var path = Path.GetFullPath(c["DataPath"] ?? ".runtime");
            Directory.CreateDirectory(path);
            o.UseSqlite("Data Source=" + Path.Combine(path, "framelab.db"));
        }
        return new(o.Options);
    }
}

public class Account
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Username { get; set; } = "";
    public string Name { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public bool Admin { get; set; }
}

public class Session
{
    public string Id { get; set; } = "";
    public string AccountId { get; set; } = "";
    public long Until { get; set; }
}

public class Project
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerId { get; set; } = "";
    public string Name { get; set; } = "";
    public long Revision { get; set; } = 1;
    public string Document { get; set; } = JsonSerializer.Serialize(new EditDocument());
    public long Updated { get; set; } = DateTime.UtcNow.Ticks;
}

public class Member
{
    public string ProjectId { get; set; } = "";
    public string AccountId { get; set; } = "";
    public string Role { get; set; } = "viewer";
}

public class Asset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProjectId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "video";
    public string State { get; set; } = "queued";
    public string SourceKey { get; set; } = "";
    public string ProxyKey { get; set; } = "";
    public string PosterKey { get; set; } = "";
    public string WaveKey { get; set; } = "";
    public double Duration { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool HasAudio { get; set; }
    public long Bytes { get; set; }
    public string Error { get; set; } = "";
}

public class Upload
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProjectId { get; set; } = "";
    public string AccountId { get; set; } = "";
    public string Key { get; set; } = "";
    public string Name { get; set; } = "";
    public string Hash { get; set; } = "";
    public long Total { get; set; }
    public long Received { get; set; }
    public string? AssetId { get; set; }
}

public class Job
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProjectId { get; set; } = "";
    public string Key { get; set; } = "";
    public string Kind { get; set; } = "render";
    public string Payload { get; set; } = "";
    public string State { get; set; } = "queued";
    public double Progress { get; set; }
    public string Stage { get; set; } = "Sırada";
    public string Error { get; set; } = "";
    public string OutputKey { get; set; } = "";
    public string LeaseOwner { get; set; } = "";
    public long LeaseUntil { get; set; }
    public int Attempt { get; set; }
    public long Created { get; set; } = DateTime.UtcNow.Ticks;
}

public class ProjectVersion
{
    public string ProjectId { get; set; } = "";
    public long Revision { get; set; }
    public string Name { get; set; } = "";
    public string Document { get; set; } = "";
    public long Created { get; set; } = DateTime.UtcNow.Ticks;
}

public class Comment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProjectId { get; set; } = "";
    public string AuthorId { get; set; } = "";
    public string Author { get; set; } = "";
    public string Text { get; set; } = "";
    public double At { get; set; }
    public long Created { get; set; } = DateTime.UtcNow.Ticks;
}

public class WorkerStatus
{
    public string Id { get; set; } = "";
    public long Seen { get; set; }
}

public class EditDocument
{
    public string Format { get; set; } = "landscape";
    public List<Clip> Clips { get; set; } = [];
    public string? MusicId { get; set; }
    public double MusicVolume { get; set; } = .2;
}

public class Clip
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string AssetId { get; set; } = "";
    public double In { get; set; }
    public double Out { get; set; }
    public double Volume { get; set; } = 1;
    public bool Muted { get; set; }
    public string Title { get; set; } = "";
    public int TitleSize { get; set; } = 56;
    public string TitlePosition { get; set; } = "bottom";
    public string Transition { get; set; } = "cut";
}

public record RenderInput(EditDocument Document, string Preset, long Revision);

public class Fault(int status, string message) : Exception(message)
{
    public int Status => status;
}

public static class Wire
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static T Read<T>(string json) => JsonSerializer.Deserialize<T>(json, Json)!;

    public static string Write(object data) => JsonSerializer.Serialize(data, Json);
}
