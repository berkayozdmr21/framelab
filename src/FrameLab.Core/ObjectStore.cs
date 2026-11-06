using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.Extensions.Configuration;
using Minio;
using Minio.DataModel.Args;

namespace FrameLab;

public class ObjectStore
{
    readonly string root;
    readonly IMinioClient? s3;
    readonly string bucket;
    readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new();

    public ObjectStore(IConfiguration c)
    {
        root = Path.GetFullPath(c["MediaPath"] ?? ".runtime/media");
        Directory.CreateDirectory(root);
        bucket = c["S3:Bucket"] ?? "framelab";
        if (c["S3:Endpoint"] is string endpoint && endpoint.Length > 0)
            s3 = new MinioClient()
                .WithEndpoint(endpoint)
                .WithCredentials(c["S3:AccessKey"], c["S3:SecretKey"])
                .WithSSL(c.GetValue<bool>("S3:Ssl"))
                .Build();
    }

    public string Local(string key)
    {
        if (
            string.IsNullOrEmpty(key)
            || key.Split('/').Any(x => x is "" or "." or "..")
            || key.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('/' or '-' or '_' or '.'))
        )
            throw new ArgumentException("Geçersiz nesne anahtarı.");
        var path = Path.GetFullPath(
            Path.Combine(root, key.Replace('/', Path.DirectorySeparatorChar))
        );
        if (
            !path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
        )
            throw new ArgumentException();
        return path;
    }

    public async Task Put(string key, string source, CancellationToken ct = default)
    {
        var path = Local(key);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (s3 != null)
        {
            await using var stream = File.OpenRead(source);
            await s3.PutObjectAsync(
                new PutObjectArgs()
                    .WithBucket(bucket)
                    .WithObject(key)
                    .WithStreamData(stream)
                    .WithObjectSize(stream.Length)
                    .WithContentType("application/octet-stream"),
                ct
            );
        }
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var src = File.OpenRead(source))
            await using (var dest = File.Create(temp))
            {
                await src.CopyToAsync(dest, ct);
            }
            File.Move(temp, path, true);
        }
        finally
        {
            if (File.Exists(temp))
                File.Delete(temp);
        }
    }

    public async Task<string> Get(string key, CancellationToken ct = default)
    {
        var path = Local(key);
        if (File.Exists(path))
            return path;
        if (s3 == null)
            throw new FileNotFoundException("Kaynak nesne bulunamadı.");
        var gate = locks.GetOrAdd(key, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (File.Exists(path))
                return path;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await using (var dest = File.Create(temp))
                    await s3.GetObjectAsync(
                        new GetObjectArgs()
                            .WithBucket(bucket)
                            .WithObject(key)
                            .WithCallbackStream(s => s.CopyTo(dest)),
                        ct
                    );
                File.Move(temp, path, true);
            }
            finally
            {
                if (File.Exists(temp))
                    File.Delete(temp);
            }
            return path;
        }
        finally
        {
            gate.Release();
        }
    }

    public static async Task<string> Hash(string file)
    {
        await using var f = File.OpenRead(file);
        return Convert.ToHexString(await SHA256.HashDataAsync(f)).ToLowerInvariant();
    }
}
