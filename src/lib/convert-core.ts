import { Clipboard } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getPreferenceValues } from "@raycast/api";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

export type ConverterKind = "magick" | "ffmpeg" | "pandoc" | "libreoffice";
export type OutputDestination = "clipboard" | "save" | "both";
export type FileCategory = "image" | "audio" | "video" | "doc" | "unknown";

export type ToolFormats = {
  bin: string;
  input: string[];
  output: string[];
};

export type Preferences = {
  magickPath?: string;
  ffmpegPath?: string;
  pandocPath?: string;
  libreofficePath?: string;
};

export type ConverterDecision = {
  kind: ConverterKind;
  tool: ToolFormats;
  category: FileCategory;
  defaultOutput: string;
};

const toolCache: Partial<Record<ConverterKind, ToolFormats | null>> = {};
const preferences = getPreferenceValues<Preferences>();

export const imagePreferredExts = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "svg",
  "ico",
  "psd",
  "tga",
]);

const audioExts = new Set([
  "aac",
  "aiff",
  "alac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "wma",
]);

const videoExts = new Set([
  "avi",
  "mkv",
  "mov",
  "mp4",
  "m4v",
  "webm",
  "wmv",
  "flv",
]);

const libreOfficeInput = [
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "csv",
  "html",
  "htm",
];

const libreOfficeOutput = ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "txt", "html"];

export const normalizeExt = (value: string) => value.trim().replace(/^\./, "").toLowerCase();

export const getFileExt = (filePath: string) => normalizeExt(path.extname(filePath));

const uniqueSorted = (values: string[]) => Array.from(new Set(values.filter(Boolean))).sort();

const normalizePref = (value?: string) => (value ?? "").trim();

const canRun = async (cmd: string, args: string[]) => {
  try {
    await execFileAsync(cmd, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
};

const resolvePreferred = async (value: string | undefined, probeArgs: string[]) => {
  const preferred = normalizePref(value);
  if (!preferred) return null;
  const ok = await canRun(preferred, probeArgs);
  return ok ? preferred : null;
};

const findBinary = async (cmd: string): Promise<string | null> => {
  const locator = isWindows ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [cmd], {
      windowsHide: true,
    });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (first) return first;
  } catch {
    // ignore
  }
  return null;
};

const findMagickOnWindows = async (): Promise<string | null> => {
  if (!isWindows) return null;
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(
    (root): root is string => !!root,
  );
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().startsWith("imagemagick-")) continue;
        const exePath = path.join(root, entry.name, "magick.exe");
        try {
          await access(exePath);
          return exePath;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
};

const ensureMagick = async (): Promise<ToolFormats | null> => {
  if (toolCache.magick !== undefined) return toolCache.magick ?? null;

  let bin = await resolvePreferred(preferences.magickPath, ["-version"]);
  if (!bin) {
    const candidates = isWindows ? ["magick"] : ["magick", "convert"];
    for (const candidate of candidates) {
      const resolved = await findBinary(candidate);
      if (resolved) {
        bin = candidate;
        break;
      }
    }
  }
  if (!bin) {
    bin = await findMagickOnWindows();
  }
  if (!bin) {
    toolCache.magick = null;
    return null;
  }

  const formats = await loadMagickFormats(bin);
  toolCache.magick = { bin, ...formats };
  return toolCache.magick;
};

const ensureFfmpeg = async (): Promise<ToolFormats | null> => {
  if (toolCache.ffmpeg !== undefined) return toolCache.ffmpeg ?? null;
  const preferred = await resolvePreferred(preferences.ffmpegPath, ["-version"]);
  const bin = preferred ?? ((await findBinary("ffmpeg")) ? "ffmpeg" : null);
  if (!bin) {
    toolCache.ffmpeg = null;
    return null;
  }
  const formats = await loadFfmpegFormats(bin);
  toolCache.ffmpeg = { bin, ...formats };
  return toolCache.ffmpeg;
};

const ensurePandoc = async (): Promise<ToolFormats | null> => {
  if (toolCache.pandoc !== undefined) return toolCache.pandoc ?? null;
  const preferred = await resolvePreferred(preferences.pandocPath, ["--version"]);
  const bin = preferred ?? ((await findBinary("pandoc")) ? "pandoc" : null);
  if (!bin) {
    toolCache.pandoc = null;
    return null;
  }
  const formats = await loadPandocFormats(bin);
  toolCache.pandoc = { bin, ...formats };
  return toolCache.pandoc;
};

const ensureLibreOffice = async (): Promise<ToolFormats | null> => {
  if (toolCache.libreoffice !== undefined) return toolCache.libreoffice ?? null;
  const preferred = await resolvePreferred(preferences.libreofficePath, ["--version"]);
  if (preferred) {
    toolCache.libreoffice = {
      bin: preferred,
      input: libreOfficeInput,
      output: libreOfficeOutput,
    };
    return toolCache.libreoffice;
  }
  const candidates = isWindows ? ["soffice"] : ["soffice", "libreoffice"];
  let bin: string | null = null;
  for (const candidate of candidates) {
    const resolved = await findBinary(candidate);
    if (resolved) {
      bin = candidate;
      break;
    }
  }
  if (!bin) {
    toolCache.libreoffice = null;
    return null;
  }
  toolCache.libreoffice = {
    bin,
    input: libreOfficeInput,
    output: libreOfficeOutput,
  };
  return toolCache.libreoffice;
};

const loadMagickFormats = async (bin: string) => {
  try {
    const { stdout } = await execFileAsync(bin, ["-list", "format"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10,
    });
    const input: string[] = [];
    const output: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Format") || trimmed.startsWith("--")) {
        continue;
      }
      let format = "";
      let mode = "";
      const match = trimmed.match(/^(\S+)\s+\S+\s+([r-][w-][+-])\s+/i);
      if (match) {
        format = match[1];
        mode = match[2];
      } else {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          format = parts[0];
          mode = parts[2];
        }
      }
      if (!format || !mode) continue;
      const normalized = normalizeExt(format.replace(/\*$/, ""));
      const modeLower = mode.toLowerCase();
      if (modeLower.includes("r")) input.push(normalized);
      if (modeLower.includes("w")) output.push(normalized);
    }
    return { input: uniqueSorted(input), output: uniqueSorted(output) };
  } catch {
    return { input: [], output: [] };
  }
};

const loadFfmpegFormats = async (bin: string) => {
  try {
    const { stdout } = await execFileAsync(bin, ["-hide_banner", "-formats"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10,
    });
    const input: string[] = [];
    const output: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*([D.])([E.])\s+(\S+)/);
      if (!match) continue;
      const demux = match[1] === "D";
      const mux = match[2] === "E";
      const formats = match[3].split(",").map((format) => normalizeExt(format));
      if (demux) input.push(...formats);
      if (mux) output.push(...formats);
    }
    return { input: uniqueSorted(input), output: uniqueSorted(output) };
  } catch {
    return { input: [], output: [] };
  }
};

const loadPandocFormats = async (bin: string) => {
  try {
    const [inputResult, outputResult] = await Promise.all([
      execFileAsync(bin, ["--list-input-formats"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(bin, ["--list-output-formats"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const input = uniqueSorted(inputResult.stdout.split(/\s+/).map((format) => normalizeExt(format)));
    const output = uniqueSorted(outputResult.stdout.split(/\s+/).map((format) => normalizeExt(format)));
    return { input, output };
  } catch {
    return { input: [], output: [] };
  }
};

const getCategory = (ext: string, kind: ConverterKind): FileCategory => {
  if (kind === "magick") return "image";
  if (kind === "pandoc" || kind === "libreoffice") return "doc";
  if (audioExts.has(ext)) return "audio";
  if (videoExts.has(ext)) return "video";
  return "unknown";
};

export const pickDefaultOutput = (category: FileCategory, outputs: string[]) => {
  const preferredByCategory: Record<FileCategory, string[]> = {
    image: ["png", "jpg", "jpeg", "webp"],
    audio: ["wav", "mp3", "aac"],
    video: ["mp4", "mov", "mkv"],
    doc: ["pdf", "docx", "txt"],
    unknown: ["png", "pdf", "mp4"],
  };
  const preferred = preferredByCategory[category] ?? [];
  for (const candidate of preferred) {
    if (outputs.includes(candidate)) return candidate;
  }
  return outputs[0] ?? preferred[0] ?? "png";
};

export const detectConverter = async (ext: string): Promise<ConverterDecision | null> => {
  const magick = await ensureMagick();
  const ffmpeg = await ensureFfmpeg();
  const pandoc = await ensurePandoc();
  const libreoffice = await ensureLibreOffice();

  if (imagePreferredExts.has(ext) && magick?.input.includes(ext)) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }
  if (ffmpeg?.input.includes(ext)) {
    const category = getCategory(ext, "ffmpeg");
    return {
      kind: "ffmpeg",
      tool: ffmpeg,
      category,
      defaultOutput: pickDefaultOutput(category, ffmpeg.output),
    };
  }
  if (pandoc?.input.includes(ext)) {
    const category = getCategory(ext, "pandoc");
    return {
      kind: "pandoc",
      tool: pandoc,
      category,
      defaultOutput: pickDefaultOutput(category, pandoc.output),
    };
  }
  if (libreoffice?.input.includes(ext)) {
    const category = getCategory(ext, "libreoffice");
    return {
      kind: "libreoffice",
      tool: libreoffice,
      category,
      defaultOutput: pickDefaultOutput(category, libreoffice.output),
    };
  }
  if (magick?.input.includes(ext)) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }

  if (magick) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }
  if (ffmpeg) {
    const category = getCategory(ext, "ffmpeg");
    return {
      kind: "ffmpeg",
      tool: ffmpeg,
      category,
      defaultOutput: pickDefaultOutput(category, ffmpeg.output),
    };
  }
  if (pandoc) {
    const category = getCategory(ext, "pandoc");
    return {
      kind: "pandoc",
      tool: pandoc,
      category,
      defaultOutput: pickDefaultOutput(category, pandoc.output),
    };
  }
  if (libreoffice) {
    const category = getCategory(ext, "libreoffice");
    return {
      kind: "libreoffice",
      tool: libreoffice,
      category,
      defaultOutput: pickDefaultOutput(category, libreoffice.output),
    };
  }

  return null;
};

export const runCommand = async (cmd: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const details = [err.message, err.stdout, err.stderr].filter(Boolean).join("\n");
    throw new Error(details || "Conversion failed");
  }
};

export const convertWithTool = async (opts: {
  inputPath: string;
  outputPath: string;
  outputExt: string;
  overwrite: boolean;
  converter: ConverterKind;
  tool: ToolFormats;
}) => {
  const { inputPath, outputPath, outputExt, overwrite, converter, tool } = opts;

  if (!overwrite) {
    try {
      await access(outputPath);
      throw new Error("Output file already exists. Enable overwrite or choose another name.");
    } catch {
      // file does not exist
    }
  }

  switch (converter) {
    case "magick":
      await runCommand(tool.bin, [inputPath, outputPath]);
      return outputPath;
    case "ffmpeg": {
      const args = ["-hide_banner", "-loglevel", "error"];
      args.push(overwrite ? "-y" : "-n");
      args.push("-i", inputPath, outputPath);
      await runCommand(tool.bin, args);
      return outputPath;
    }
    case "pandoc":
      await runCommand(tool.bin, [inputPath, "-o", outputPath]);
      return outputPath;
    case "libreoffice": {
      const outDir = path.dirname(outputPath);
      await runCommand(tool.bin, ["--headless", "--convert-to", outputExt, "--outdir", outDir, inputPath]);
      return outputPath;
    }
    default:
      throw new Error("Unsupported converter");
  }
};

export const buildOutputPath = (
  inputPath: string,
  outputExt: string,
  outputDir: string | null,
  destination: OutputDestination,
) => {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const safeExt = normalizeExt(outputExt);
  if (destination === "clipboard") {
    const unique = randomUUID();
    return path.join(os.tmpdir(), `${baseName}-converted-${unique}.${safeExt}`);
  }
  const dir = outputDir && outputDir.length > 0 ? outputDir : path.dirname(inputPath);
  return path.join(dir, `${baseName}.${safeExt}`);
};

export const readClipboardFile = async (): Promise<string | null> => {
  const content = await Clipboard.read();
  if (content.file) return content.file;
  if (content.text) {
    const trimmed = content.text.trim();
    if (!trimmed) return null;
    const pathCandidate = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
    try {
      await access(pathCandidate);
      return pathCandidate;
    } catch {
      return null;
    }
  }
  const imagePath = await readClipboardImageToTemp();
  if (imagePath) return imagePath;
  return null;
};

const readClipboardImageToTemp = async (): Promise<string | null> => {
  if (isWindows) {
    return await readClipboardImageWindows();
  }
  return await readClipboardImageMac();
};

const readClipboardImageWindows = async (): Promise<string | null> => {
  const tempPath = path.join(os.tmpdir(), `raycast-clipboard-${randomUUID()}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($null -eq $img) { exit 2 }",
    `$img.Save('${tempPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "$img.Dispose();",
  ].join(" ");
  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    await access(tempPath);
    return tempPath;
  } catch {
    return null;
  }
};

const readClipboardImageMac = async (): Promise<string | null> => {
  const pngpaste = await findBinary("pngpaste");
  if (!pngpaste) return null;
  const tempPath = path.join(os.tmpdir(), `raycast-clipboard-${randomUUID()}.png`);
  try {
    await execFileAsync(pngpaste, [tempPath], {
      maxBuffer: 1024 * 1024,
    });
    await access(tempPath);
    return tempPath;
  } catch {
    return null;
  }
};

export const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
};

export const isImageExt = (ext: string) => imagePreferredExts.has(ext);
