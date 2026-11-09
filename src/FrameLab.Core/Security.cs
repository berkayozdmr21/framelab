using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace FrameLab;

public static class Security
{
    public static string Hash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    public static string Password(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        return Convert.ToBase64String(salt)
            + ":"
            + Convert.ToBase64String(
                Rfc2898DeriveBytes.Pbkdf2(password, salt, 210000, HashAlgorithmName.SHA256, 32)
            );
    }

    public static bool Check(string password, string hash)
    {
        var parts = hash.Split(':');
        var expected = Convert.FromBase64String(parts[1]);
        var value = Rfc2898DeriveBytes.Pbkdf2(
            password,
            Convert.FromBase64String(parts[0]),
            210000,
            HashAlgorithmName.SHA256,
            32
        );
        return CryptographicOperations.FixedTimeEquals(expected, value);
    }

    public static async Task<Account> User(HttpContext c, FrameDb db)
    {
        var token = c.Request.Headers.Authorization.ToString().StartsWith("Bearer ")
            ? c.Request.Headers.Authorization.ToString()[7..]
            : c.Request.Cookies["framelab-session"];
        if (string.IsNullOrEmpty(token))
            throw new Fault(401, "Oturum açın.");
        var hash = Hash(token);
        var now = DateTime.UtcNow.Ticks;
        var session =
            await db.Sessions.SingleOrDefaultAsync(s =>
                s.Id == hash && s.Until > now
            ) ?? throw new Fault(401, "Oturum süresi doldu.");
        return await db.Accounts.SingleAsync(a => a.Id == session.AccountId);
    }

    public static async Task<(Project Project, Account User, string Role)> Access(
        string id,
        HttpContext c,
        FrameDb db,
        bool write = false,
        bool owner = false
    )
    {
        var u = await User(c, db);
        var p = await db.Projects.FindAsync(id) ?? throw new Fault(404, "Proje bulunamadı.");
        var role = p.OwnerId == u.Id ? "owner" : (await db.Members.FindAsync(id, u.Id))?.Role;
        if (role == null)
            throw new Fault(404, "Proje bulunamadı.");
        if (owner && role != "owner" || write && role is not ("owner" or "editor"))
            throw new Fault(403, "Bu işlem için düzenleme yetkisi gerekli.");
        return (p, u, role);
    }

    public static async Task Validate(
        EditDocument d,
        string projectId,
        FrameDb db,
        bool render = false
    )
    {
        if (
            d == null
            || d.Clips == null
            || d.Clips.Count > 12
            || render && d.Clips.Count == 0
            || !new[] { "landscape", "portrait", "square" }.Contains(d.Format)
            || !double.IsFinite(d.MusicVolume)
            || d.MusicVolume < 0
            || d.MusicVolume > 1
        )
            throw new Fault(400, "Zaman çizelgesi geçersiz; en fazla 12 klip.");
        var assets = await db
            .Assets.Where(a => a.ProjectId == projectId && a.State == "ready")
            .ToListAsync();
        var ids = new HashSet<string>();
        double duration = 0;
        foreach (var clip in d.Clips)
        {
            if (
                clip == null
                || !Guid.TryParse(clip.Id, out _)
                || !ids.Add(clip.Id)
                || clip.Title == null
                || clip.Title.Length > 120
                || clip.TitleSize is < 16 or > 96
                || !new[] { "center", "bottom" }.Contains(clip.TitlePosition)
                || !new[] { "cut", "fade" }.Contains(clip.Transition)
                || !double.IsFinite(clip.In)
                || !double.IsFinite(clip.Out)
                || !double.IsFinite(clip.Volume)
                || clip.Volume is < 0 or > 2
                || clip.In < 0
                || clip.Out - clip.In < .2
            )
                throw new Fault(400, "Klip alanları geçersiz.");
            var asset =
                assets.SingleOrDefault(a => a.Id == clip.AssetId && a.Kind == "video")
                ?? throw new Fault(400, "Hazır video seçin.");
            if (clip.Out > asset.Duration + .03)
                throw new Fault(400, "Klip kaynak süresini aşıyor.");
            duration += clip.Out - clip.In;
        }
        if (duration > 180)
            throw new Fault(400, "Proje en fazla 3 dakika olabilir.");
        if (d.MusicId != null && !assets.Any(a => a.Id == d.MusicId && a.Kind == "audio"))
            throw new Fault(400, "Hazır bir ses dosyası seçin.");
    }
}
