// Runs the HyperFrames CLI with the bundled ffmpeg and ffprobe on PATH (it needs both, and neither is installed system-wide).
//   node video/hf.js render video -c showcase.html --output video/out/showcase.mp4
import { spawnSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
const env = { ...process.env, [key]: [dirname(ffmpegStatic), dirname(ffprobeStatic.path), process.env[key]].join(delimiter) };
const { status } = spawnSync('npx', ['-y', 'hyperframes', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true });
process.exit(status ?? 1);
