# HypeClip (testing service)

HypeClip monitors publicly available YouTube live chat through the YouTube Data API v3 and detects spikes in chat volume. Video is captured separately from an authorized direct HLS source, or alternatively through browser tab capture.

## Clean-video recording (server-side beta)

A YouTube watch URL and YouTube Data API key **do not** provide a downloadable raw video stream. Only record a video source you own or are authorized to use. YouTube's API policies restrict downloading and storing YouTube audiovisual content without appropriate approval. This service does not attempt to scrape YouTube playback streams.

1. Obtain a direct HTTPS HLS \`.m3u8\` feed from your own streaming encoder, CDN, or authorized provider.
2. In Render > HypeClip web service > Environment, add:
   - \`HYPECLIP_ALLOWED_HLS_HOSTS\`: comma-separated exact hostnames of your approved streaming CDN (e.g. \`video.example.com,edge.example.com\`). Do **not** include a URL, scheme, path, wildcard, or IP.
   - Keep \`HYPECLIP_PASSWORD\` and \`YOUTUBE_API_KEY\` configured as before.
3. Redeploy / save environment, then paste your HTTPS HLS playlist into **Background recording • clean video**.
4. Click **Start background recording**. HypeClip checks allowed hostnames and public DNS addresses, reads a master playlist if provided, and selects the highest-advertised resolution variant. FFmpeg records native source video/audio into rotating MPEG-TS chunks.
5. Separately start YouTube live-chat monitoring for hype triggers, if you have a YouTube live URL with chat. Manual test clipping also works without YouTube chat.
6. Completed clips have three links: **MP4**, **Timestamp CSV**, and **JSON**.

The direct HLS playlist is used for video only. It does not include the YouTube webpage, chat panel, subscriptions, screen-share UI, or other browser overlays. Selecting 1080p or a larger output resolution cannot increase source quality beyond what the direct feed provides.

**Clock alignment:** The event timestamp is the server time (UTC) when a chat hype trigger fires. The stream offset is **elapsed time since server recording started**, not elapsed time since the original livestream began. Exact in-video alignment is approximate because stream encoding, HLS playlist latency, server receive time, and segment boundaries differ. Logs include eventUTC, clipWindowStartUTC, clipWindowEndUTC, streamElapsedAtEvent, requestedBeforeSeconds, requestedAfterSeconds, and outputQuality.

## Limitations

- Server recording can continue while the dashboard tab is closed **only while the Render instance remains awake**. Render Free services sleep after inactivity. For unattended recording, use an always-on host; do not assume that a running process prevents sleeping.
- Render Free service storage is ephemeral. Segments, MP4s and timestamp logs can disappear on restart or redeploy. Download promptly. Persistent cloud object storage and an always-on worker are recommended before 24/7 recording.
- Video capture can fail if an HLS CDN requires cookies, signed expiring URLs, special headers, unsupported encryption, or blocks Render IP addresses.
- Source hostnames are configured by the operator; FFmpeg may request subsequent playlist segment URLs. Only use trusted streaming infrastructure that you control or have permission to access.
- The browser tab-capture fallback remains available for streams without an authorized direct HLS feed. Browser capture may include visible page elements; server HLS capture does not.
- HypeClip has a single shared recording session and settings for this temporary testing deployment, protected by one HTTP Basic Authentication password.
- MP4 encoding can use significant CPU and disk space on Render Free. Long 1080p recordings or multiple simultaneous streams require paid resources and external storage.

## Routes

- \`GET /healthz\`: health.
- \`POST /api/server-capture/start\`: \`{"hlsUrl":"https://.../live.m3u8"}\`
- \`POST /api/server-capture/stop\`: stop server capture.
- \`GET /api/recording-status\`: current capture mode and segment count.
- \`POST /api/clip\`: create a manual clip using the current video source.
- \`GET /api/clips/<id>.mp4\`: MP4 download.
- \`GET /api/clips/<id>.csv\`: timestamp log CSV.
- \`GET /api/clips/<id>.json\`: clip metadata.

## Local setup

\`npm install && HYPECLIP_PASSWORD=local-testing-password npm start\`

For YouTube chat, set \`YOUTUBE_API_KEY\` in environment variables. Never commit any API key, access token, streaming playlist signature, or password to GitHub.
