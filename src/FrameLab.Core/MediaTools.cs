using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;

namespace FrameLab;

public record MediaInfo(double Duration, int Width, int Height, bool HasAudio, bool HasVideo);

public class MediaTools(IConfiguration config)
{
    public string Ffmpeg => config["FFmpegPath"] ?? "ffmpeg";
    public string Ffprobe => config["FFprobePath"] ?? "ffprobe";
    public string Font =>
        config["FontPath"]
        ?? (
            OperatingSystem.IsWindows()
                ? "C:/Windows/Fonts/arial.ttf"
                : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        );

    public static string N(double n) => n.ToString("0.######", CultureInfo.InvariantCulture);

    public async Task<string> Run(
        string executable,
        IEnumerable<string> args,
        string directory,
        CancellationToken ct,
        Action<string>? line = null,
        int seconds = 300
    )
    {
        Directory.CreateDirectory(directory);
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = directory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var a in args)
            start.ArgumentList.Add(a);
        using var process =
            Process.Start(start)
            ?? throw new InvalidOperationException("Medya aracı başlatılamadı.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
        using var kill = timeout.Token.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(true);
            }
            catch (InvalidOperationException) { }
        });
        var output = new StringBuilder();
        var read = Task.Run(async () =>
        {
            while (await process.StandardOutput.ReadLineAsync() is string text)
            {
                if (output.Length < 200000)
                    output.AppendLine(text);
                line?.Invoke(text);
            }
        });
        var errors = new StringBuilder();
        var err = Task.Run(async () =>
        {
            while (await process.StandardError.ReadLineAsync() is string text)
            {
                if (errors.Length < 30000)
                    errors.AppendLine(text);
            }
        });
        await process.WaitForExitAsync(CancellationToken.None);
        await Task.WhenAll(read, err);
        ct.ThrowIfCancellationRequested();
        if (timeout.IsCancellationRequested)
            throw new InvalidOperationException("Medya işlemi zaman sınırını aştı.");
        if (process.ExitCode != 0)
        {
            Console.Error.WriteLine(errors.ToString());
            throw new InvalidOperationException(
                "Medya işlenemedi. Dosya biçimini ve zaman aralığını kontrol edin."
            );
        }
        return output.ToString();
    }

    static string[] Restricted =>
        [
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov,matroska,webm,mp3,wav,aac,flac",
        ];

    public async Task<MediaInfo> Probe(string path, CancellationToken ct)
    {
        var args = new List<string>
        {
            "-v",
            "error",
            "-probesize",
            "33554432",
            "-analyzeduration",
            "10000000",
        };
        args.AddRange(Restricted);
        args.AddRange(["-show_format", "-show_streams", "-of", "json", path]);
        var text = await Run(Ffprobe, args, Path.GetDirectoryName(path)!, ct, seconds: 30);
        using var json = JsonDocument.Parse(text);
        var root = json.RootElement;
        var duration = double.Parse(
            root.GetProperty("format").GetProperty("duration").GetString()!,
            CultureInfo.InvariantCulture
        );
        var streams = root.GetProperty("streams").EnumerateArray().ToArray();
        var videos = streams
            .Where(s => s.GetProperty("codec_type").GetString() == "video")
            .ToArray();
        var audio = streams.Any(s => s.GetProperty("codec_type").GetString() == "audio");
        var width = videos.Length == 0 ? 0 : videos[0].GetProperty("width").GetInt32();
        var height = videos.Length == 0 ? 0 : videos[0].GetProperty("height").GetInt32();
        if (
            !double.IsFinite(duration)
            || duration <= 0
            || duration > 600
            || width > 3840
            || height > 3840
            || (long)width * height > 3840L * 2160
            || (!audio && videos.Length == 0)
        )
            throw new InvalidOperationException("Medya en fazla 10 dakika ve 4K olabilir.");
        return new(duration, width, height, audio, videos.Length > 0);
    }

    public async Task Ingest(
        Asset asset,
        ObjectStore store,
        string directory,
        CancellationToken ct,
        Action<double, string> progress
    )
    {
        var source = await store.Get(asset.SourceKey, ct);
        var info = await Probe(source, ct);
        asset.Duration = info.Duration;
        asset.Width = info.Width;
        asset.Height = info.Height;
        asset.HasAudio = info.HasAudio;
        asset.Kind = info.HasVideo ? "video" : "audio";
        var stem = Guid.NewGuid().ToString("N");
        var proxy = Path.Combine(directory, stem + (info.HasVideo ? ".mp4" : ".m4a"));
        var args = new List<string> { "-y", "-nostdin", "-v", "error" };
        args.AddRange(Restricted);
        args.AddRange(["-i", source]);
        if (info.HasVideo)
            args.AddRange([
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-vf",
                "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "25",
                "-pix_fmt",
                "yuv420p",
            ]);
        else
            args.AddRange(["-vn"]);
        args.AddRange([
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-threads",
            "2",
            "-filter_threads",
            "1",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            proxy,
        ]);
        await Run(
            Ffmpeg,
            args,
            directory,
            ct,
            line =>
            {
                if (line.StartsWith("out_time_us=") && double.TryParse(line[12..], out var us))
                    progress(
                        Math.Min(.8, us / 1000000 / info.Duration * .8),
                        "Önizleme hazırlanıyor"
                    );
            }
        );
        asset.ProxyKey = "proxies/" + stem + Path.GetExtension(proxy);
        await store.Put(asset.ProxyKey, proxy, ct);
        var poster = Path.Combine(directory, stem + ".jpg");
        if (info.HasVideo)
        {
            await Run(
                Ffmpeg,
                [
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    N(Math.Min(info.Duration / 3, 1)),
                    "-i",
                    proxy,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    poster,
                ],
                directory,
                ct,
                seconds: 30
            );
            asset.PosterKey = "posters/" + stem + ".jpg";
            await store.Put(asset.PosterKey, poster, ct);
        }
        if (info.HasAudio)
        {
            var wave = Path.Combine(directory, stem + ".png");
            await Run(
                Ffmpeg,
                [
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    proxy,
                    "-filter_complex",
                    "aformat=channel_layouts=mono,showwavespic=s=1200x100:colors=0x9c654e",
                    "-frames:v",
                    "1",
                    wave,
                ],
                directory,
                ct,
                seconds: 30
            );
            asset.WaveKey = "waves/" + stem + ".png";
            await store.Put(asset.WaveKey, wave, ct);
            if (!info.HasVideo)
                asset.PosterKey = asset.WaveKey;
        }
        asset.State = "ready";
        asset.Error = "";
        progress(.95, "Medya hazır");
    }

    public async Task<string> Render(
        RenderInput input,
        List<Asset> assets,
        ObjectStore store,
        string directory,
        CancellationToken ct,
        Action<double, string> progress
    )
    {
        var (width, height) = input.Document.Format switch
        {
            "portrait" => (1080, 1920),
            "square" => (1080, 1080),
            _ => (1920, 1080),
        };
        if (input.Preset == "720p")
        {
            width = width * 2 / 3;
            height = height * 2 / 3;
        }
        File.Copy(Font, Path.Combine(directory, "font.ttf"), true);
        var files = new List<string>();
        var total = input.Document.Clips.Sum(c => c.Out - c.In);
        for (var i = 0; i < input.Document.Clips.Count; i++)
        {
            var clip = input.Document.Clips[i];
            var asset = assets.Single(a => a.Id == clip.AssetId);
            var source = await store.Get(asset.SourceKey, ct);
            var duration = clip.Out - clip.In;
            var name = $"segment{i}.mp4";
            var args = new List<string>
            {
                "-y",
                "-nostdin",
                "-v",
                "error",
                "-ss",
                N(clip.In),
                "-t",
                N(duration),
            };
            args.AddRange(Restricted);
            args.AddRange(["-i", source]);
            if (!asset.HasAudio)
                args.AddRange([
                    "-f",
                    "lavfi",
                    "-t",
                    N(duration),
                    "-i",
                    "anullsrc=r=48000:cl=stereo",
                ]);
            args.AddRange(["-map", "0:v:0", "-map", asset.HasAudio ? "0:a:0" : "1:a:0"]);
            var video =
                $"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30";
            var audio = $"aresample=48000,volume={N(clip.Muted ? 0 : clip.Volume)}";
            if (clip.Title.Length > 0)
            {
                await File.WriteAllTextAsync(
                    Path.Combine(directory, $"title{i}.txt"),
                    clip.Title,
                    new UTF8Encoding(false),
                    ct
                );
                video +=
                    $",drawtext=fontfile=font.ttf:textfile=title{i}.txt:expansion=none:fontcolor=white:fontsize={clip.TitleSize * height / 1080}:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=(w-text_w)/2:y="
                    + (clip.TitlePosition == "center" ? "(h-text_h)/2" : "h-text_h-h*0.09");
            }
            if (clip.Transition == "fade")
            {
                var fade = Math.Min(.25, duration / 3);
                video +=
                    $",fade=t=in:st=0:d={N(fade)},fade=t=out:st={N(duration - fade)}:d={N(fade)}";
                audio +=
                    $",afade=t=in:st=0:d={N(fade)},afade=t=out:st={N(duration - fade)}:d={N(fade)}";
            }
            args.AddRange([
                "-vf",
                video,
                "-af",
                audio,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "21",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-threads",
                "2",
                "-filter_threads",
                "1",
                "-t",
                N(duration),
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                name,
            ]);
            var index = i;
            await Run(
                Ffmpeg,
                args,
                directory,
                ct,
                line =>
                {
                    if (line.StartsWith("out_time_us=") && double.TryParse(line[12..], out var us))
                        progress(
                            .8
                                * (index + Math.Min(1, us / 1000000 / duration))
                                / input.Document.Clips.Count,
                            $"Klip {index + 1}/{input.Document.Clips.Count}"
                        );
                }
            );
            files.Add(name);
        }
        await File.WriteAllLinesAsync(
            Path.Combine(directory, "concat.txt"),
            files.Select(f => "file '" + f + "'"),
            ct
        );
        progress(.83, "Klipler birleştiriliyor");
        await Run(
            Ffmpeg,
            [
                "-y",
                "-v",
                "error",
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
                "concat.txt",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "merged.mp4",
            ],
            directory,
            ct
        );
        var result = Path.Combine(directory, "merged.mp4");
        if (input.Document.MusicId is string music)
        {
            var track = assets.Single(a => a.Id == music);
            var path = await store.Get(track.ProxyKey, ct);
            progress(.9, "Sesler birleştiriliyor");
            await Run(
                Ffmpeg,
                [
                    "-y",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    "merged.mp4",
                    "-stream_loop",
                    "-1",
                    "-i",
                    path,
                    "-filter_complex",
                    $"[1:a]volume={N(input.Document.MusicVolume)}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]",
                    "-map",
                    "0:v:0",
                    "-map",
                    "[a]",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-t",
                    N(total),
                    "-movflags",
                    "+faststart",
                    "output.mp4",
                ],
                directory,
                ct
            );
            result = Path.Combine(directory, "output.mp4");
        }
        var probe = await Probe(result, ct);
        if (
            probe.Width != width
            || probe.Height != height
            || Math.Abs(probe.Duration - total) > .4
            || new FileInfo(result).Length > 300L * 1024 * 1024
        )
            throw new InvalidOperationException("Çıktı doğrulaması başarısız.");
        progress(.98, "Çıktı doğrulandı");
        return result;
    }

    public async Task<string> Sample(int index, string directory, CancellationToken ct)
    {
        File.Copy(Font, Path.Combine(directory, "font.ttf"), true);
        var name = $"sample{index}.mp4";
        var filter =
            $"gradients=s=1280x720:r=30:d=6:c0={(index == 0 ? "0x1c3534" : "0xa14730")}:c1={(index == 0 ? "0x9d815e" : "0xe1bd91")}:speed=0.02,drawgrid=width=80:height=80:thickness=1:color=white@0.07,drawtext=fontfile=font.ttf:text='FORM / 0{index + 1}':fontsize=104:fontcolor=white:x='80+12*sin(t)':y=250,drawtext=fontfile=font.ttf:text='A MOTION STUDY':fontsize=24:fontcolor=white@0.6:x=85:y=380";
        await Run(
            Ffmpeg,
            [
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                filter,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-threads",
                "2",
                "-t",
                "6",
                name,
            ],
            directory,
            ct
        );
        return Path.Combine(directory, name);
    }
}
