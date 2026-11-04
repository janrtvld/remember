# Feature sections

Selected from the feature prototype on September 9, 2026.

- One three-point overview and three alternating feature sections.
- Equal 50/50 desktop columns. At 900px and below, copy stacks above the video.
- Full landscape videos with vertically centered copy in equally tall adjoining
  cells. Each section has its own recording and poster.
- Empty bordered rows before the first feature, between features, before the
  FAQ, and before the footer: 64px on desktop, 40px at 760px and below. All use
  `--section-spacer-height`. The FAQ and footer rows no longer have decorative
  cells or corner crosses; the small-cell grid remains in the hero.
- Shared small blue buttons labeled "Get started", localized in Dutch.
- Figtree headings at 30px/36px and Manrope body copy at 14px.
- Removed numbered rows, category pill labels, and green-check detail cells
  because the page felt busy.

The selected layout now lives in `FeatureSections.tsx` and
`feature-sections.css`, below the existing product preview in `LandingPage.tsx`.
The feature prototype and its picker are removed. No reminder or team Wiki
behavior is implemented by these sections. This integration is a local edit,
not a deployment.

## Video

Each 1632×1080 public demonstration recording is
stream-copied as H.264/yuv420p at its original 60 fps with faststart metadata,
without another compression pass, audio, or cropping. The wrapper reserves the
dimensions passed with each video.

| Section | Original filename | Web video | Video bytes | Poster bytes |
| --- | --- | --- | ---: | ---: |
| Conversations | `convos.mp4` | `/videos/convos.mp4` | 2,264,934 | 80,202 |
| Follow-ups | `recognized.mp4` | `/videos/recognized.mp4` | 4,525,466 | 119,602 |
| Project memory | `wiki.mp4` | `/videos/wiki.mp4` | 3,353,588 | 161,432 |

Posters use lossless WebP with the same filename and `-poster.webp`. The videos
total 10,143,988 bytes. The earlier CRF 24, 30 fps encodes saved space but softened
fine interface text and reduced motion smoothness.

`FeatureVideo.tsx` attaches each video URL only when its cell enters the
viewport, pauses outside the viewport or in a hidden tab, and preserves manual
pause. Reduced-motion visitors see the poster until they press Play.
Black 28px playback controls with filled 14px icons appear on video hover or
keyboard focus. Touch devices keep the controls visible, with a 44px hit area.

To prepare replacement footage, use a recording made with synthetic sample data.
Original capture files are not included in the repository. Poster frames use
6 seconds for conversations and follow-ups, and 3 for Wiki.

```sh
ffmpeg -i /path/to/convos.mp4 -map 0:v:0 -an -c:v copy \
  -movflags +faststart -map_metadata -1 -y apps/site/public/videos/convos.mp4
ffmpeg -ss 6 -i /path/to/convos.mp4 -frames:v 1 \
  -c:v libwebp -lossless 1 -compression_level 6 \
  -y apps/site/public/videos/convos-poster.webp
```
