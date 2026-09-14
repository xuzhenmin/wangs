#!/usr/bin/env node
// Synthetic test double, not a media encoder. Never used by the application by default.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) process.stdout.write('fixture-video-tool 1.0\n');
else if (args.includes('-show_streams')) process.stdout.write(JSON.stringify({ format: { duration: 2 }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));
else writeFileSync(args.at(-1), 'fixture-only-mp4');
