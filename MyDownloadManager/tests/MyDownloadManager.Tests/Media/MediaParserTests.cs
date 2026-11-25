using MyDownloadManager.Media;
using MyDownloadManager.Media.Dash;
using MyDownloadManager.Media.Hls;

namespace MyDownloadManager.Tests.Media;

public class MediaParserTests
{
    private static readonly Uri Base = new("https://cdn.example.com/video/master.m3u8");

    [Fact]
    public void Hls_Master_ParsesVariantsAndAudio()
    {
        var m = HlsParser.ParseMaster("""
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",URI="audio/de.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
            720/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360,AUDIO="aud"
            https://other.example.com/360/index.m3u8
            """, Base);
        Assert.Equal(2, m.Variants.Count);
        Assert.Equal(720, m.Variants[0].Height);
        Assert.Equal("avc1.4d401f,mp4a.40.2", m.Variants[0].Codecs);
        Assert.Equal("https://cdn.example.com/video/720/index.m3u8", m.Variants[0].PlaylistUri!.AbsoluteUri);
        Assert.Equal("https://other.example.com/360/index.m3u8", m.Variants[1].PlaylistUri!.AbsoluteUri);
        Assert.Equal(2, m.Audio.Count);
        Assert.True(m.Audio[0].IsDefault);
        Assert.Equal("aud", m.Variants[1].AudioGroup);
    }

    [Fact]
    public void Hls_Media_ParsesSegmentsKeysByteRangesAndMap()
    {
        var p = HlsParser.ParseMedia("""
            #EXTM3U
            #EXT-X-TARGETDURATION:4
            #EXT-X-MEDIA-SEQUENCE:7
            #EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:1000@720
            media.mp4
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:500
            media.mp4
            #EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x0000000000000000000000000000ABCD
            #EXTINF:2.5,
            seg3.m4s
            #EXT-X-KEY:METHOD=NONE
            #EXTINF:1,
            seg4.m4s
            #EXT-X-ENDLIST
            """, Base);
        Assert.True(p.HasEndList);
        Assert.Null(p.DrmSystem);
        Assert.Equal(new ByteRange(0, 720), p.Init!.Range);
        Assert.Equal(4, p.Segments.Count);
        Assert.Equal(new ByteRange(720, 1000), p.Segments[0].Range);
        Assert.Equal(new ByteRange(1720, 500), p.Segments[1].Range);
        Assert.Equal(7, p.Segments[0].Sequence);
        Assert.Equal("https://keys.example.com/k1", p.Segments[2].Key!.KeyUri.AbsoluteUri);
        Assert.Equal(0xCD, p.Segments[2].Key!.IV![15]);
        Assert.Null(p.Segments[3].Key);
        Assert.Equal(11.5, p.TotalDuration, 3);
    }

    [Theory]
    [InlineData("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\",KEYFORMAT=\"com.apple.streamingkeydelivery\"", "FairPlay")]
    [InlineData("#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:x\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"", "Widevine")]
    [InlineData("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"https://k\"", "SAMPLE-AES")]
    [InlineData("#EXT-X-KEY:METHOD=AES-128,URI=\"skd://x\"", "FairPlay")]
    public void Hls_DrmIsDetected(string keyLine, string expected)
    {
        var p = HlsParser.ParseMedia($"#EXTM3U\n{keyLine}\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n", Base);
        Assert.Contains(expected, p.DrmSystem);
    }

    [Fact]
    public void Hls_RejectsNonPlaylist() =>
        Assert.Throws<MediaFormatException>(() => HlsParser.ParseMedia("<html>", Base));

    [Theory]
    [InlineData("$RepresentationID$/seg-$Number%05d$.m4s", "v1/seg-00042.m4s")]
    [InlineData("t_$Time$_$Bandwidth$.m4s", "t_9000_128000.m4s")]
    [InlineData("a$$b-$Number$", "a$b-42")]
    public void Dash_TemplateExpansion(string template, string expected) =>
        Assert.Equal(expected, DashParser.Expand(template, "v1", 42, 9000, 128000));

    private const string Mpd = """
        <?xml version="1.0"?>
        <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
          <BaseURL>https://cdn.example.com/dash/</BaseURL>
          <Period>
            <AdaptationSet contentType="video" mimeType="video/mp4">
              <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s" startNumber="1">
                <SegmentTimeline><S t="0" d="4000" r="1"/><S d="2000"/></SegmentTimeline>
              </SegmentTemplate>
              <Representation id="v720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f"/>
              <Representation id="v360" bandwidth="600000" width="640" height="360" codecs="avc1.64001e"/>
            </AdaptationSet>
            <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
              <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
                <SegmentTemplate timescale="48000" duration="96000" media="a/$Number%03d$.m4s" initialization="a/init.mp4" startNumber="0"/>
              </Representation>
            </AdaptationSet>
          </Period>
        </MPD>
        """;

    [Fact]
    public void Dash_ParsesTimelineAndDurationTemplates()
    {
        var m = DashParser.Parse(Mpd, new Uri("https://site.example.com/manifest.mpd"));
        Assert.False(m.IsLive);
        Assert.Null(m.DrmSystem);
        Assert.Equal(10, m.DurationSeconds);
        Assert.Equal(2, m.Video.Count);
        var v = m.Video[0];
        Assert.Equal(720, v.Height);
        Assert.Equal(["https://cdn.example.com/dash/v720/1.m4s", "https://cdn.example.com/dash/v720/2.m4s", "https://cdn.example.com/dash/v720/3.m4s"],
            v.Track.Segments.Select(s => s.Uri.AbsoluteUri));
        Assert.Equal("https://cdn.example.com/dash/v720/init.mp4", v.Track.Init!.Uri.AbsoluteUri);
        var a = Assert.Single(m.Audio);
        Assert.Equal(5, a.Track.Segments.Count); // 10 s / 2 s
        Assert.Equal("https://cdn.example.com/dash/a/000.m4s", a.Track.Segments[0].Uri.AbsoluteUri);
    }

    [Theory]
    [InlineData("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", "Widevine")]
    [InlineData("urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", "PlayReady")]
    [InlineData("urn:mpeg:dash:mp4protection:2011", "CENC")]
    public void Dash_ContentProtection_IsDrm(string scheme, string expected)
    {
        var xml = Mpd.Replace("<AdaptationSet contentType=\"video\" mimeType=\"video/mp4\">",
            $"<AdaptationSet contentType=\"video\" mimeType=\"video/mp4\"><ContentProtection schemeIdUri=\"{scheme}\"/>");
        var m = DashParser.Parse(xml, new Uri("https://x.example.com/m.mpd"));
        Assert.Contains(expected, m.DrmSystem);
        Assert.Empty(m.Video);
    }

    [Fact]
    public void Dash_LiveAndDtdAreHandled()
    {
        Assert.True(DashParser.Parse(Mpd.Replace("type=\"static\"", "type=\"dynamic\""), new Uri("https://x/m.mpd")).IsLive);
        var xxe = "<?xml version=\"1.0\"?><!DOCTYPE MPD [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><MPD>&x;</MPD>";
        Assert.Throws<MediaFormatException>(() => DashParser.Parse(xxe, new Uri("https://x/m.mpd")));
    }

    [Theory]
    [InlineData("https://x.com/a/master.m3u8?token=1", null, MediaFormat.Hls)]
    [InlineData("https://x.com/a/manifest.mpd", null, MediaFormat.Dash)]
    [InlineData("https://x.com/a/video.webm", null, MediaFormat.Direct)]
    [InlineData("https://x.com/api/stream", "application/x-mpegURL", MediaFormat.Hls)]
    [InlineData("https://x.com/page.html", "text/html", null)]
    public void DetectFormat(string url, string? contentType, MediaFormat? expected) =>
        Assert.Equal(expected, MediaResolver.DetectFormat(url, contentType));

    [Fact]
    public void SequenceIv_IsBigEndian()
    {
        var iv = MediaDownloadEngine.SequenceIv(0x0102);
        Assert.Equal(0x01, iv[14]);
        Assert.Equal(0x02, iv[15]);
        Assert.All(iv[..14], b => Assert.Equal(0, b));
    }

    [Fact]
    public void MediaSelection_RoundTrips()
    {
        var s = MediaSelection.Parse(new MediaSelection { VideoId = "v1", Container = "mkv" }.ToJson());
        Assert.Equal("v1", s.VideoId);
        Assert.Equal("mkv", s.Container);
        Assert.Equal("mp4", MediaSelection.Parse("not json").Container);
    }
}
