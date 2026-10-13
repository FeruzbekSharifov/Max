// Native helpers for Max, compiled at startup by server.ps1 (Add-Type, C# 5).
//  - MaxTts:   Microsoft Edge "Read Aloud" neural voices (free, no key) over a raw WebSocket,
//              because .NET Framework's ClientWebSocket refuses to send a User-Agent header.
//  - MaxAudio: master volume / mute through the Windows Core Audio API.
//  - MaxKeys:  media & volume keys.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public class MaxTtsResult
{
    public byte[] Audio;
    public List<object[]> Words = new List<object[]>(); // [offsetMs, durationMs, text]
}

public static class MaxTts
{
    const string Host = "speech.platform.bing.com";
    const string Token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    public static string ChromiumVersion = "143.0.3650.75";
    public static double SkewSeconds = 0;
    static bool skewKnown = false;

    // The service validates a time-based token, so a PC clock that is a few minutes off breaks it.
    public static void SyncClock()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("https://" + Host + "/");
            req.Method = "HEAD";
            req.Timeout = 8000;
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException e) { resp = e.Response as HttpWebResponse; }
            if (resp == null) return;
            using (resp)
            {
                var date = resp.Headers["Date"];
                DateTime server;
                if (date != null && DateTime.TryParse(date, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out server))
                {
                    SkewSeconds = (server - DateTime.UtcNow).TotalSeconds;
                    skewKnown = true;
                }
            }
        }
        catch { }
    }

    static string Gec()
    {
        double unix = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds + SkewSeconds;
        long ticks = (long)Math.Floor(unix) + 11644473600L;
        ticks -= ticks % 300;
        string s = (ticks * 10000000L).ToString() + Token;
        using (var sha = SHA256.Create())
        {
            var sb = new StringBuilder();
            foreach (var b in sha.ComputeHash(Encoding.ASCII.GetBytes(s))) sb.Append(b.ToString("X2"));
            return sb.ToString();
        }
    }

    static string Esc(string t)
    {
        return t.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&apos;");
    }

    // ---- connection reuse: opening TLS + WebSocket costs 1-5 s on slow links, so keep a few warm ----
    const int PoolSize = 4;   // two parts of a reply + spares for racing slow answers
    static readonly object gate = new object();
    static readonly List<EdgeConn> pool = new List<EdgeConn>();
    public static string LastError = "";

    class EdgeConn : IDisposable
    {
        public TcpClient Tcp;
        public SslStream Ssl;
        public DateTime Opened = DateTime.UtcNow;
        public DateTime LastUsed = DateTime.UtcNow;
        public long LastFirstAudioMs = -1;
        public bool Fresh
        {
            get
            {
                var now = DateTime.UtcNow;
                if (Tcp == null || !Tcp.Connected) return false;
                // the service drops idle connections after ~35-40 s
                if ((now - LastUsed).TotalSeconds >= 30 || (now - Opened).TotalSeconds >= 270) return false;
                // an idle connection has nothing to read; if it is readable, the server has closed it
                try { return !Tcp.Client.Poll(0, SelectMode.SelectRead); } catch { return false; }
            }
        }
        public void Dispose()
        {
            try { if (Ssl != null) Ssl.Dispose(); } catch { }
            try { if (Tcp != null) Tcp.Close(); } catch { }
        }
    }

    static EdgeConn Open()
    {
        string path = "/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=" + Token +
            "&ConnectionId=" + Guid.NewGuid().ToString("N") + "&Sec-MS-GEC=" + Gec() +
            "&Sec-MS-GEC-Version=1-" + ChromiumVersion;
        string major = ChromiumVersion.Split('.')[0];
        var c = new EdgeConn();
        try
        {
            c.Tcp = new TcpClient();
            c.Tcp.ReceiveTimeout = 15000;
            c.Tcp.SendTimeout = 15000;
            c.Tcp.NoDelay = true;
            c.Tcp.Connect(Host, 443);
            c.Ssl = new SslStream(c.Tcp.GetStream());
            c.Ssl.AuthenticateAsClient(Host, null, SslProtocols.Tls12, false);
            string handshake =
                "GET " + path + " HTTP/1.1\r\n" +
                "Host: " + Host + "\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: " + Convert.ToBase64String(Guid.NewGuid().ToByteArray()) + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "Pragma: no-cache\r\n" +
                "Cache-Control: no-cache\r\n" +
                "Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n" +
                "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
                    major + ".0.0.0 Safari/537.36 Edg/" + major + ".0.0.0\r\n" +
                "Accept-Language: en-US,en;q=0.9\r\n" +
                "Cookie: muid=" + Guid.NewGuid().ToString("N").ToUpper() + ";\r\n\r\n";
            var hb = Encoding.ASCII.GetBytes(handshake);
            c.Ssl.Write(hb, 0, hb.Length);

            string status = ReadHttpHeader(c.Ssl);
            if (!status.StartsWith("HTTP/1.1 101"))
                throw new IOException("TTS handshake failed: " + status.Split('\r')[0]);

            SendText(c.Ssl, "X-Timestamp:" + Stamp() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
                "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}," +
                "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n");
            return c;
        }
        catch
        {
            c.Dispose();
            throw;
        }
    }

    static string Stamp()
    {
        return DateTime.UtcNow.ToString("ddd MMM dd yyyy HH:mm:ss 'GMT+0000 (Coordinated Universal Time)'",
            System.Globalization.CultureInfo.InvariantCulture);
    }

    static int pendingOpens = 0;

    static void Prune()
    {
        for (int i = pool.Count - 1; i >= 0; i--)
            if (!pool[i].Fresh) { pool[i].Dispose(); pool.RemoveAt(i); }
    }

    // ---- keeper: while Max is in use, keep PoolSize connections open and recycle them before the
    // service drops them, so a reply never has to wait for a new TLS + WebSocket handshake.
    static DateTime lastActivity = DateTime.MinValue;
    static Thread keeper;

    public static void StartKeeper()
    {
        lock (gate)
        {
            if (keeper != null) return;
            keeper = new Thread(KeeperLoop);
            keeper.IsBackground = true;
            keeper.Start();
        }
    }

    static void KeeperLoop()
    {
        while (true)
        {
            try
            {
                // Background traffic slows down a reply that is being synthesized at the same moment,
                // so stay quiet while Max is speaking and right after the user starts talking.
                bool quiet = activeSpeaks > 0 || DateTime.UtcNow < quietUntil;
                if (!quiet && (DateTime.UtcNow - lastActivity).TotalMinutes < 10)
                {
                    // A tiny "Hi." keeps a connection from being dropped as idle. Only one connection is
                    // borrowed at a time, so the others stay ready for a reply.
                    EdgeConn c = null;
                    lock (gate)
                    {
                        Prune();
                        for (int i = 0; i < pool.Count; i++)
                            if ((DateTime.UtcNow - pool[i].LastUsed).TotalSeconds > 22 && (c == null || pool[i].LastUsed < c.LastUsed)) c = pool[i];
                        if (c != null) { pool.Remove(c); touching++; }
                    }
                    if (c != null)
                    {
                        try
                        {
                            bool w = false;
                            Turn(c, SsmlFor("Hi.", WarmVoice, "+0%", "+0Hz", "+0%"), Stream.Null, ref w);
                            c.LastUsed = DateTime.UtcNow;
                            lock (gate) { if (pool.Count < PoolSize) { pool.Add(c); c = null; } }
                        }
                        catch { }
                        if (c != null) c.Dispose();
                        lock (gate) touching--;
                    }
                    int missing;
                    lock (gate) missing = PoolSize - pool.Count - pendingOpens - touching;
                    for (int i = 0; i < missing; i++) Prewarm(false);
                }
            }
            catch { }
            Thread.Sleep(1000);
        }
    }

    static int touching = 0;
    static int activeSpeaks = 0;
    static DateTime quietUntil = DateTime.MinValue;

    // Called when the user starts talking: a reply is coming, so make sure warm connections exist
    // but otherwise keep the line quiet for it.
    public static void Prewarm() { Prewarm(true); }

    static void Prewarm(bool userActivity)
    {
        if (userActivity) { lastActivity = DateTime.UtcNow; quietUntil = DateTime.UtcNow.AddSeconds(4); }
        lock (gate)
        {
            Prune();
            int have = pool.Count + pendingOpens + touching;
            if (have >= PoolSize || (userActivity && have >= 2)) return;
            pendingOpens++;
        }
        try
        {
            if (!skewKnown) SyncClock();
            var c = Open();
            // The first sentence on a new connection takes 1-3 s; every later one ~0.2 s.
            // So spend that first turn on a throwaway "Hi." before the connection joins the pool.
            try
            {
                bool w = false;
                Turn(c, SsmlFor("Hi.", WarmVoice, "+0%", "+0Hz", "+0%"), Stream.Null, ref w);
                c.LastUsed = DateTime.UtcNow;
            }
            catch { c.Dispose(); throw; }
            lock (gate)
            {
                if (pool.Count < PoolSize) { pool.Add(c); c = null; }
            }
            if (c != null) c.Dispose();
        }
        catch (Exception e) { LastError = e.Message; }
        finally { lock (gate) { pendingOpens--; } }
    }

    public static string LastTake = "";

    static EdgeConn Take()
    {
        // A brand-new connection is slow on its first sentence (1-3 s), so if a warm one is about to be
        // available (being kept alive or warmed up right now), waiting for it briefly is faster.
        var waited = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            lock (gate)
            {
                Prune();
                if (pool.Count > 0)
                {
                    var c = pool[pool.Count - 1];
                    pool.RemoveAt(pool.Count - 1);
                    LastTake = "pool(" + (pool.Count + 1) + ")" + (waited.ElapsedMilliseconds > 30 ? " after " + waited.ElapsedMilliseconds + " ms" : "");
                    return c;
                }
                if ((touching == 0 && pendingOpens == 0) || waited.ElapsedMilliseconds > 1500) break;
            }
            Thread.Sleep(20);
        }
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var n = Open();
        LastTake = "opened in " + sw.ElapsedMilliseconds + " ms";
        return n;
    }

    static void GiveBack(EdgeConn c)
    {
        c.LastUsed = DateTime.UtcNow;
        lock (gate)
        {
            if (pool.Count < PoolSize) { pool.Add(c); return; }
        }
        c.Dispose();
    }

    // ---- hedged synthesis ----
    // The service sometimes sits several seconds on one attempt while another answers normally. So if an
    // attempt is clearly overdue, a second one races it; whichever delivers audio first streams out.

    class Race
    {
        public readonly object Lock = new object();
        public Stream Output;
        public string Ssml;
        public Racer Winner;
        public readonly List<Racer> Racers = new List<Racer>();
        public readonly AutoResetEvent Signal = new AutoResetEvent(false);
    }

    class Racer
    {
        public volatile EdgeConn Conn;
        public volatile bool Done;
        public List<object[]> Words;
        public Exception Error;
    }

    // Lets only the first racer that produces audio write to the real output.
    class RaceSink : Stream
    {
        readonly Race race;
        readonly Racer me;
        public RaceSink(Race r, Racer m) { race = r; me = m; }
        public override void Write(byte[] buffer, int offset, int count)
        {
            List<Racer> losers = null;
            lock (race.Lock)
            {
                if (race.Winner == null) { race.Winner = me; losers = race.Racers.FindAll(x => x != me); }
                else if (race.Winner != me) throw new OperationCanceledException("lost the race");
            }
            if (losers != null)
            {
                foreach (var l in losers) { var c = l.Conn; if (c != null) c.Dispose(); }
                race.Signal.Set();
            }
            race.Output.Write(buffer, offset, count);
        }
        public override void Flush() { race.Output.Flush(); }
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
    }

    static void Launch(Race race)
    {
        var me = new Racer();
        lock (race.Lock) race.Racers.Add(me);
        var t = new Thread(() => RunRacer(race, me));
        t.IsBackground = true;
        t.Start();
    }

    static void RunRacer(Race race, Racer me)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            EdgeConn c = null;
            bool wrote = false;
            try
            {
                c = Take();
                bool lost;
                lock (race.Lock) { lost = race.Winner != null; if (!lost) me.Conn = c; }
                if (lost) { GiveBack(c); c = null; break; }   // still a good warm connection
                me.Words = Turn(c, race.Ssml, new RaceSink(race, me), ref wrote);
                me.Conn = null;
                // slowness tends to stick to a connection, so don't keep a slow one around
                if (c.LastFirstAudioMs > 1500) c.Dispose(); else GiveBack(c);
                me.Error = null;
                break;
            }
            catch (Exception e)
            {
                me.Conn = null;
                if (c != null) c.Dispose();
                me.Error = e;
                bool lost;
                lock (race.Lock) lost = race.Winner != null && race.Winner != me;
                if (lost || wrote) break;
                LastError = e.Message;
                if (e.Message.Contains("403")) SyncClock();
            }
        }
        me.Done = true;
        race.Signal.Set();
    }

    // Streams MP3 into `output` as it arrives from the service. Returns word timings [offsetMs, durationMs, text].
    public static List<object[]> SpeakTo(Stream output, string text, string voice, string rate, string pitch, string volume)
    {
        lastActivity = DateTime.UtcNow;
        WarmVoice = voice;
        // A new sentence normally needs ~1 s + ~0.11 s per word before its first audio. Only when an
        // attempt is clearly slower than that does a second attempt race it.
        int words = text.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Length;
        int hedge = (int)((1000 + 110 * words) * 1.6);
        Interlocked.Increment(ref activeSpeaks);
        try { return SpeakRace(output, SsmlFor(text, voice, rate, pitch, volume), new[] { hedge }); }
        finally { Interlocked.Decrement(ref activeSpeaks); quietUntil = DateTime.UtcNow.AddSeconds(1); }
    }

    static List<object[]> SpeakRace(Stream output, string ssml, int[] hedgeAt)
    {
        if (!skewKnown) SyncClock();
        var race = new Race();
        race.Output = output;
        race.Ssml = ssml;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Launch(race);
        int hedges = 0;
        while (sw.ElapsedMilliseconds < 120000)
        {
            race.Signal.WaitOne(50);
            Racer winner;
            bool allDone;
            lock (race.Lock) { winner = race.Winner; allDone = race.Racers.TrueForAll(r => r.Done); }
            if (winner != null)
            {
                if (!winner.Done) continue;
                if (winner.Error != null) LastError = winner.Error.Message;
                return winner.Words ?? new List<object[]>();
            }
            if (hedges < hedgeAt.Length && (allDone || sw.ElapsedMilliseconds >= hedgeAt[hedges])) { Launch(race); hedges++; continue; }
            if (allDone) break;
        }
        throw new IOException("TTS failed: " + LastError);
    }

    public static string WarmVoice = "Microsoft Server Speech Text to Speech Voice (en-US, BrianMultilingualNeural)";

    static string SsmlFor(string text, string voice, string rate, string pitch, string volume)
    {
        return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
            "<voice name='" + Esc(voice) + "'><prosody pitch='" + Esc(pitch) + "' rate='" + Esc(rate) + "' volume='" + Esc(volume) + "'>" +
            Esc(text) + "</prosody></voice></speak>";
    }

    public static MaxTtsResult Synthesize(string text, string voice, string rate, string pitch, string volume)
    {
        var ms = new MemoryStream();
        var r = new MaxTtsResult();
        r.Words = SpeakTo(ms, text, voice, rate, pitch, volume);
        r.Audio = ms.ToArray();
        return r;
    }

    public static string LastTiming = "";

    static List<object[]> Turn(EdgeConn c, string ssml, Stream output, ref bool wrote)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        bool reused = c.LastUsed > c.Opened.AddMilliseconds(1);
        SendText(c.Ssl, "X-RequestId:" + Guid.NewGuid().ToString("N") + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + Stamp() +
            "Z\r\nPath:ssml\r\n\r\n" + ssml);
        var words = new List<object[]>();
        long first = -1;
        while (true)
        {
            int opcode;
            byte[] msg = ReadMessage(c.Ssl, out opcode);
            if (opcode == 8) throw new IOException("TTS connection closed by server");
            if (opcode == 1)
            {
                string t = Encoding.UTF8.GetString(msg);
                if (t.Contains("Path:turn.end")) break;
                if (t.Contains("Path:audio.metadata")) ParseWords(t, words);
            }
            else if (opcode == 2 && msg.Length >= 2)
            {
                int hl = (msg[0] << 8) | msg[1];
                string hdr = Encoding.ASCII.GetString(msg, 2, Math.Min(hl, msg.Length - 2));
                if (hdr.Contains("Path:audio") && msg.Length > 2 + hl)
                {
                    if (first < 0) first = sw.ElapsedMilliseconds;
                    output.Write(msg, 2 + hl, msg.Length - 2 - hl);
                    output.Flush();
                    wrote = true;
                }
            }
        }
        if (!wrote) throw new IOException("TTS returned no audio");
        c.LastFirstAudioMs = first;
        LastTiming = (reused ? "reused" : "fresh") + " conn, first audio " + first + " ms, total " + sw.ElapsedMilliseconds + " ms";
        return words;
    }

    static void ParseWords(string t, List<object[]> words)
    {
        int i = t.IndexOf("\r\n\r\n");
        if (i < 0) return;
        string json = t.Substring(i + 4);
        foreach (Match m in Regex.Matches(json,
            "\"Offset\"\\s*:\\s*(\\d+)\\s*,\\s*\"Duration\"\\s*:\\s*(\\d+).*?\"Text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"",
            RegexOptions.Singleline))
        {
            words.Add(new object[] {
                long.Parse(m.Groups[1].Value) / 10000,
                long.Parse(m.Groups[2].Value) / 10000,
                Regex.Unescape(m.Groups[3].Value) });
        }
    }

    static string ReadHttpHeader(Stream s)
    {
        var sb = new StringBuilder();
        int b;
        while ((b = s.ReadByte()) != -1)
        {
            sb.Append((char)b);
            if (sb.Length >= 4 && sb.ToString(sb.Length - 4, 4) == "\r\n\r\n") break;
            if (sb.Length > 16384) break;
        }
        return sb.ToString();
    }

    static void SendText(Stream s, string text)
    {
        byte[] payload = Encoding.UTF8.GetBytes(text);
        var frame = new MemoryStream();
        frame.WriteByte(0x81);
        if (payload.Length < 126) frame.WriteByte((byte)(0x80 | payload.Length));
        else if (payload.Length <= 0xFFFF)
        {
            frame.WriteByte(0x80 | 126);
            frame.WriteByte((byte)(payload.Length >> 8));
            frame.WriteByte((byte)payload.Length);
        }
        else
        {
            frame.WriteByte(0x80 | 127);
            for (int i = 7; i >= 0; i--) frame.WriteByte((byte)((long)payload.Length >> (8 * i)));
        }
        var mask = new byte[4];
        new Random().NextBytes(mask);
        frame.Write(mask, 0, 4);
        for (int i = 0; i < payload.Length; i++) frame.WriteByte((byte)(payload[i] ^ mask[i % 4]));
        var bytes = frame.ToArray();
        s.Write(bytes, 0, bytes.Length);
        s.Flush();
    }

    static void ReadExact(Stream s, byte[] buf, int count)
    {
        int off = 0;
        while (off < count)
        {
            int n = s.Read(buf, off, count - off);
            if (n <= 0) throw new IOException("TTS connection closed");
            off += n;
        }
    }

    // Reads one (possibly fragmented) WebSocket message; answers pings along the way.
    static byte[] ReadMessage(Stream s, out int opcode)
    {
        var data = new MemoryStream();
        opcode = -1;
        while (true)
        {
            var h = new byte[2];
            ReadExact(s, h, 2);
            bool fin = (h[0] & 0x80) != 0;
            int op = h[0] & 0x0F;
            bool masked = (h[1] & 0x80) != 0;
            long len = h[1] & 0x7F;
            if (len == 126) { var e = new byte[2]; ReadExact(s, e, 2); len = (e[0] << 8) | e[1]; }
            else if (len == 127) { var e = new byte[8]; ReadExact(s, e, 8); len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | e[i]; }
            byte[] mask = null;
            if (masked) { mask = new byte[4]; ReadExact(s, mask, 4); }
            var payload = new byte[len];
            ReadExact(s, payload, (int)len);
            if (masked) for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];

            if (op == 9) { continue; } // ping: the service never relies on pongs for a single short request
            if (op == 10) continue;
            if (op != 0) opcode = op;
            data.Write(payload, 0, payload.Length);
            if (fin) return data.ToArray();
        }
    }
}

// ---- Core Audio master volume ----
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume
{
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class MaxAudio
{
    static IAudioEndpointVolume Vol()
    {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume epv = null;
        var epvid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
        return epv;
    }
    public static int GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
    public static void SetVolume(int percent)
    {
        percent = Math.Max(0, Math.Min(100, percent));
        Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(percent / 100f, Guid.Empty));
    }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    public static void SetMute(bool mute) { Marshal.ThrowExceptionForHR(Vol().SetMute(mute, Guid.Empty)); }
}

// If the server's main loop stops ticking, exit so the next Max.bat starts a healthy copy.
public static class MaxWatchdog
{
    static DateTime last = DateTime.UtcNow;
    static Thread t;
    public static string LogPath;
    public static void Beat() { last = DateTime.UtcNow; }
    public static void Start(int seconds)
    {
        if (t != null) return;
        t = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(5000);
                if ((DateTime.UtcNow - last).TotalSeconds > seconds)
                {
                    try { File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] Main loop stalled - exiting.\r\n"); } catch { }
                    Environment.Exit(3);
                }
            }
        });
        t.IsBackground = true;
        t.Start();
    }
}

public static class MaxKeys
{
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static void Press(byte vk)
    {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}
